import { scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { announceScheduledMessagesChanged } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { readQueuedChatMessage } from '@/shared/utils.js';

/**
 * How often due messages are looked for.
 *
 * A minute is the granularity the composer offers, and a claim is indexed on
 * `(status, scheduled_for)`, so the poll is one cheap query. Anything finer
 * would buy precision nobody asked for.
 */
const POLL_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let dispatchInFlight = false;
/** Asks for a pass soon. A no-op until the dispatcher is initialized. */
let requestDispatchPass: () => void = () => {};
let stopRunCompletedListener: (() => void) | null = null;
/**
 * Sessions running a turn a scheduled message started. Their next due message
 * waits for that turn instead of interrupting it.
 */
const scheduledRunsInFlight = new Set<string>();

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  const message = readQueuedChatMessage(candidate.queuedMessage);
  if (!message) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: message.content,
      options: { ...message.options, attachments: message.attachments },
    },
    { runtime },
  );

  // The registry check and run reservation are separate operations. If a run
  // wins that tiny race, put the turn back so the next poll tries again.
  if (!result.started && result.error === 'A run was already in progress for this session.') {
    sessionDraftsDb.restoreQueuedMessage(candidate);
    return;
  }
  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
}

/**
 * Whether a queued turn has to keep waiting for the session.
 *
 * A turn that ends with background work still going (a backgrounded command,
 * agent or workflow) is marked completed, but its CLI process stays open so
 * that work can report back. A new turn replaces that process and stops the
 * work, which is why the composer asks before an interactive send. A queued
 * turn was promised to go "when this finishes", so it waits for that work too.
 */
function isSessionBusy(sessionId: string, runtime: ProviderRuntimeGateway): boolean {
  return chatRunRegistry.isProcessing(sessionId) || runtime.hasBackgroundWork(sessionId);
}

/** Sends every persisted queued turn whose session is currently idle. */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages();
  let claimed = 0;

  await Promise.all(candidates.map(async (candidate) => {
    if (isSessionBusy(candidate.sessionId, runtime)) {
      return;
    }
    if (!sessionDraftsDb.claimQueuedMessage(candidate)) {
      return;
    }
    claimed += 1;
    await sendClaimedQueuedMessage(candidate, runtime);
  }));

  return claimed;
}

/** Records why a claimed message did not go, and shows it on its session's banner. */
function recordFailure(row: ScheduledMessageRow, reason: string): void {
  scheduledMessagesDb.markFailed(row.id, reason);
  announceScheduledMessagesChanged(row.session_id);
}

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  // Recorded rather than retried, and recorded whether the run never started
  // (deleted session, unavailable provider) or started and then failed.
  // Silently dropping a message the user scheduled is worse than telling
  // them it did not go.
  const settle = (error: string | null) => {
    if (error) {
      recordFailure(row, error);
    }
    scheduledRunsInFlight.delete(row.session_id);
    requestDispatchPass();
  };

  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        options: readOptions(row.options),
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy".
        interruptActiveRun: true,
      },
      { runtime },
    );

    if (!result.started || result.error || !result.finished) {
      settle(result.error ?? (result.started ? null : 'The session was unavailable when this was due.'));
      return;
    }
    // Only the start is waited for; a long turn must not hold up other
    // sessions' messages. How it ends is recorded when it does.
    void result.finished.then(
      (outcome) => settle(outcome.error),
      (error: unknown) => settle(error instanceof Error ? error.message : String(error)),
    );
  } catch (error) {
    settle(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Sends every message whose time has come, one per session per pass.
 *
 * A session takes one run at a time, and a second message due for it must not
 * interrupt the turn the first one started, so the next one waits for the pass
 * that follows that turn's end. Each message is claimed right before its turn
 * starts, never in a batch ahead of it.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  const nextBySession = new Map<string, ScheduledMessageRow>();
  for (const row of scheduledMessagesDb.listDue(now)) {
    if (!nextBySession.has(row.session_id)) {
      nextBySession.set(row.session_id, row);
    }
  }

  let claimed = 0;
  await Promise.all([...nextBySession.values()].map(async (row) => {
    if (scheduledRunsInFlight.has(row.session_id) || !scheduledMessagesDb.claim(row.id)) {
      return;
    }
    scheduledRunsInFlight.add(row.session_id);
    claimed += 1;
    // The claim recorded it as sent, so its banner comes down now, as the
    // turn starts, rather than once the turn has finished.
    announceScheduledMessagesChanged(row.session_id);
    await sendClaimedMessage(row, runtime);
  }));

  return claimed;
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped. A pass also runs
 * whenever a turn ends, so a follow-up queued behind it does not wait for the
 * next poll.
 */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) {
    return;
  }

  let passRequested = false;
  const poll = () => {
    // A pass that overruns must not be started again underneath itself; the
    // claims are atomic but the busy checks are not. One requested meanwhile
    // runs as soon as it ends.
    if (dispatchInFlight) {
      passRequested = true;
      return;
    }
    dispatchInFlight = true;
    void dispatchDueScheduledMessages(runtime)
      .then(() => dispatchQueuedMessages(runtime))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
      })
      .finally(() => {
        dispatchInFlight = false;
        if (passRequested) {
          passRequested = false;
          poll();
        }
      });
  };

  // Deferred: a turn's `complete` goes out before the runtime decides whether
  // to hold its process open for background work, which the pass checks.
  requestDispatchPass = () => {
    setImmediate(poll);
  };
  stopRunCompletedListener = chatRunRegistry.onRunCompleted(() => requestDispatchPass());

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  stopRunCompletedListener?.();
  stopRunCompletedListener = null;
  requestDispatchPass = () => {};
}
