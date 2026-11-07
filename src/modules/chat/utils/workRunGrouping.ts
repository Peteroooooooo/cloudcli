import type { ChatMessage, WorkRunFile, WorkRunItem, WorkRunLatestStep } from '@/shared/types';
import { getToolInputPreview, groupConsecutiveTools } from '@/modules/chat/utils/toolGrouping';
import type { MessageListItem } from '@/modules/chat/utils/toolGrouping';
import { parseToolPayload } from '@/modules/chat/utils/messageTransforms';

/**
 * Folds each turn's work into one card for the phone transcript.
 *
 * A turn on a phone used to read as a column of tool rows, reasoning blocks and
 * one-line progress notes ("let me read the config first") with the reply at the
 * bottom. Everything from the first such row up to the last tool call becomes
 * one WorkRunItem; whatever follows the last tool call — the reply, or the note
 * the agent is writing right now — stays a normal row.
 */

/**
 * Notes longer than this stay visible even in the middle of a turn. Measured on
 * the user's own sessions (2026-11-08, 15 transcripts): notes followed by more
 * tool calls had p99 259 characters, final replies a median of ~1000, so a
 * longer mid-turn note is an answer worth reading rather than progress chatter.
 */
const LONG_NOTE_CHARS = 300;

/** Tools that ask the user something; a card must never hide them. */
const INTERACTIVE_TOOL_NAMES = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode']);
const FILE_EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'ApplyPatch']);
const COMMAND_TOOL_NAMES = new Set(['Bash', 'PowerShell']);
const STEP_DETAIL_MAX_CHARS = 120;

export type TranscriptItem = MessageListItem | WorkRunItem;

type CachedWorkRun = {
  run: ChatMessage[];
  showThinking: boolean;
  endTimestamp: ChatMessage['timestamp'] | undefined;
  item: WorkRunItem;
};

// Same reason as toolGrouping's cache: grouping re-runs on every stream tick
// over a fresh array, and memo(WorkRunCard) can only bail out of a card whose
// item kept its identity.
const workRunCache = new WeakMap<ChatMessage, CachedWorkRun>();

export function isWorkRunItem(item: TranscriptItem): item is WorkRunItem {
  return '_isWorkRun' in item && (item as WorkRunItem)._isWorkRun === true;
}

function isWorkStep(message: ChatMessage): boolean {
  if (message.isThinking) return true;
  return Boolean(message.isToolUse && !INTERACTIVE_TOOL_NAMES.has(String(message.toolName || '')));
}

function isProgressNote(message: ChatMessage): boolean {
  return message.type === 'assistant'
    && !message.isToolUse
    && !message.isThinking
    && !message.compact
    && !message.isTaskNotification
    && !(message.images && message.images.length > 0)
    && [...String(message.content || '').trim()].length <= LONG_NOTE_CHARS;
}

const isHidden = (message: ChatMessage, showThinking: boolean): boolean =>
  Boolean(message.isThinking && !showThinking);

const toSingleLine = (text: string): string => {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > STEP_DETAIL_MAX_CHARS ? `${single.slice(0, STEP_DETAIL_MAX_CHARS)}…` : single;
};

const baseName = (filePath: string): string => filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

const readInput = (message: ChatMessage): Record<string, unknown> => {
  const parsed = parseToolPayload(message.toolInput);
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
};

const stringField = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === 'string' ? record[key] as string : '';

/** What the card's status line says a tool call is doing: a command's description, a file's name, a pattern. */
function describeToolStep(message: ChatMessage): string {
  const toolName = String(message.toolName || '');
  const input = readInput(message);

  if (COMMAND_TOOL_NAMES.has(toolName)) {
    return toSingleLine(stringField(input, 'description') || stringField(input, 'command'));
  }
  if (FILE_EDIT_TOOL_NAMES.has(toolName) || toolName === 'Read') {
    const filePath = stringField(input, 'file_path');
    if (filePath) return baseName(filePath);
  }
  return toSingleLine(getToolInputPreview(message));
}

function getLatestStep(run: ChatMessage[], showThinking: boolean): WorkRunLatestStep | null {
  for (let index = run.length - 1; index >= 0; index -= 1) {
    const message = run[index];
    if (isHidden(message, showThinking)) continue;
    if (message.isThinking) return { kind: 'thinking' };
    if (message.isToolUse) {
      return { kind: 'tool', toolName: String(message.toolName || ''), detail: describeToolStep(message) };
    }
    const text = toSingleLine(String(message.content || ''));
    if (text) return { kind: 'text', text };
  }
  return null;
}

const isFailedTool = (message: ChatMessage): boolean =>
  Boolean(message.isToolUse && (message.toolResult?.isError || message.toolStatus === 'failed'));

/** Files the run's edit tools changed, in the order they were first touched. Failed edits changed nothing. */
function collectFiles(run: ChatMessage[]): WorkRunFile[] {
  const byPath = new Map<string, WorkRunFile>();
  for (const message of run) {
    const toolName = String(message.toolName || '');
    if (!message.isToolUse || !FILE_EDIT_TOOL_NAMES.has(toolName) || isFailedTool(message)) continue;

    const input = readInput(message);
    const path = stringField(input, 'file_path');
    if (!path) continue;

    const oldContent = toolName === 'Write' ? '' : stringField(input, 'old_string');
    const newContent = toolName === 'Write' ? stringField(input, 'content') : stringField(input, 'new_string');
    const file = byPath.get(path) ?? { path, edits: [] };
    file.edits.push({ oldContent, newContent });
    byPath.set(path, file);
  }
  return [...byPath.values()];
}

function getDurationMs(start: ChatMessage['timestamp'], end: ChatMessage['timestamp'] | undefined): number | null {
  if (end === undefined) return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null;
}

function isSameRun(cached: ChatMessage[], run: ChatMessage[]): boolean {
  return cached.length === run.length && cached.every((message, index) => message === run[index]);
}

function getWorkRun(
  run: ChatMessage[],
  showThinking: boolean,
  endTimestamp: ChatMessage['timestamp'] | undefined,
): WorkRunItem {
  const first = run[0];
  const cached = workRunCache.get(first);
  if (
    cached
    && cached.showThinking === showThinking
    && cached.endTimestamp === endTimestamp
    && isSameRun(cached.run, run)
  ) {
    return cached.item;
  }

  const item: WorkRunItem = {
    _isWorkRun: true,
    messages: run,
    items: groupConsecutiveTools(run, showThinking),
    timestamp: first.timestamp,
    stepCount: run.filter((message) => message.isToolUse).length,
    errorCount: run.filter(isFailedTool).length,
    durationMs: getDurationMs(first.timestamp, endTimestamp ?? run[run.length - 1].timestamp),
    latestStep: getLatestStep(run, showThinking),
    files: collectFiles(run),
  };
  workRunCache.set(first, { run, showThinking, endTimestamp, item });
  return item;
}

/**
 * The phone transcript's rows: each stretch of work folded into a WorkRunItem,
 * everything else as groupConsecutiveTools would have returned it.
 *
 * A stretch is a maximal run of tool calls, reasoning and short notes. Only the
 * part up to its last tool call or reasoning row is folded; notes after that are
 * the reply (or the newest progress note while the agent is still writing) and
 * stay readable. A stretch with no tool call, or with only one visible row,
 * gains nothing from a card and is left as it was.
 */
export function groupWorkRuns(messages: ChatMessage[], showThinking: boolean = true): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (!isWorkStep(message) && !isProgressNote(message)) {
      items.push(message);
      index += 1;
      continue;
    }

    let stretchEnd = index;
    let lastStep = -1;
    while (stretchEnd < messages.length && (isWorkStep(messages[stretchEnd]) || isProgressNote(messages[stretchEnd]))) {
      if (isWorkStep(messages[stretchEnd])) lastStep = stretchEnd;
      stretchEnd += 1;
    }

    const run = lastStep >= 0 ? messages.slice(index, lastStep + 1) : [];
    const visibleCount = run.filter((row) => !isHidden(row, showThinking)).length;
    const hasToolCall = run.some((row) => row.isToolUse);

    if (hasToolCall && visibleCount >= 2) {
      items.push(getWorkRun(run, showThinking, messages[lastStep + 1]?.timestamp));
    } else if (run.length > 0) {
      items.push(...groupConsecutiveTools(run, showThinking));
    }

    const trailingStart = lastStep >= 0 ? lastStep + 1 : index;
    items.push(...messages.slice(trailingStart, stretchEnd));
    index = stretchEnd;
  }

  return items;
}
