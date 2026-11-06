/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the Claude runtime adapter for consistency.
 *
 * ## Usage
 *
 * - codexRuntime.run(command, options, writer, context) - Execute a streamed prompt
 * - codexRuntime.abort(sessionId) - Cancel an active session
 */

import { Codex } from '@openai/codex-sdk';
import type { ModelReasoningEffort, Thread, ThreadOptions } from '@openai/codex-sdk';

import {
  appendFilesInputTag,
  buildCodexInputItems,
  normalizeImageDescriptors,
  createCompleteMessage,
  createNormalizedMessage,
} from '@/shared/index.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { truncateOutput } from '@/shared/message-unification.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

type ActiveCodexSession = {
  thread: Thread;
  codex: Codex;
  status: 'running' | 'aborted' | 'completed';
  abortController: AbortController;
  startedAt: string;
};

const activeCodexSessions = new Map<string, ActiveCodexSession>();

// Codex CLI requires non-whitespace stdin even when --image arguments are
// present, so attachment-only turns need a small text instruction.
const CODEX_IMAGE_ONLY_PROMPT = 'Please analyze the attached image(s).';

/**
 * Item types whose in-flight updates are worth showing. These are the ones a
 * user waits on — a shell command's output, an MCP call, and the running plan.
 */
const PROGRESSIVE_CODEX_ITEM_TYPES = new Set(['command_execution', 'mcp_tool_call', 'todo_list']);

function readUsageNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractCodexTokenBudget(event: AnyRecord) {
  const info = event?.info || event?.payload?.info || event?.usage?.info;
  const usage = info?.total_token_usage || event?.usage?.total_token_usage || event?.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = readUsageNumber(usage.input_tokens);
  const outputTokens = readUsageNumber(usage.output_tokens);
  const used = readUsageNumber(usage.total_tokens) || inputTokens + outputTokens;

  return {
    used,
    total: readUsageNumber(info?.model_context_window || event?.usage?.model_context_window) || 200000,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event: AnyRecord): AnyRecord {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // `itemId` is the SDK's stable per-item id. Carrying it through means an
      // in-progress row and its later completion normalize to the same message
      // id, so the client updates one transcript entry instead of appending a
      // new one for every progress tick.
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            itemId: item.id,
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            itemId: item.id,
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            itemId: item.id,
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            itemId: item.id,
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            itemId: item.id,
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            itemId: item.id,
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            itemId: item.id,
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            itemId: item.id,
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: item.type,
            itemId: item.id,
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.thread_id || event.id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

/**
 * Map permission mode to Codex SDK options
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode: string): Pick<ThreadOptions, 'sandboxMode' | 'approvalPolicy'> {
  switch (permissionMode) {
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        // Current Codex CLI versions reject the retired `untrusted` policy.
        // Keep sandboxing enabled; exec cannot grant interactive approval requests.
        approvalPolicy: 'on-request'
      };
  }
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
async function queryCodex(
  command: string,
  options: AnyRecord = {},
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
) {
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    effort,
    images,
    files,
    permissionMode = 'default'
  } = options;

  // Callers pass the stable app session id; the SDK resumes threads with the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);

  const resolvedModel = await context.resolveResumeModel(sessionId, model);

  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
  const catalog = await context.getProviderModels();
  const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort as ModelReasoningEffort
    : undefined;

  let codex: Codex;
  let thread: Thread;
  // Provider-native thread id (starts as the resume id, or is captured from
  // the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // A user abort ends the run on one of two paths (the loop breaks, or the SDK
  // throws its AbortError); either way it is reported as a cancellation.
  const notifyCodexRunAborted = () => {
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'codex',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      stopReason: 'aborted'
    });
  };
  let terminalFailure: { message: string } | null = null;
  // Codex surfaces API failures as streamed error items/turn.failed events, and
  // then the SDK also throws "Codex Exec exited with code N: <stderr>" once the
  // process dies. Showing both means the rendered error is followed by a raw
  // stderr dump of unrelated CLI log lines, so the thrown wrapper is dropped
  // when the stream already reported the failure.
  let errorSurfaced = false;
  const abortController = new AbortController();
  // Session-map key: the app session id when the caller supplied one, else
  // the provider-native thread id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;
  // This run's map entry. Read directly rather than through the map, which by
  // the time this run winds down may hold the session's next run.
  let runEntry: ActiveCodexSession | null = null;

  try {
    // A stop that arrived while the run was being set up found no entry to
    // abort. Past this point the entry exists and the signal is linked to it.
    const stopSignal = options.stopSignal as AbortSignal | undefined;
    if (stopSignal?.aborted) {
      notifyCodexRunAborted();
      return;
    }

    codex = new Codex();

    const threadOptions: ThreadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model: resolvedModel,
      modelReasoningEffort: resolvedEffort,
    };

    if (providerSessionId) {
      thread = codex.resumeThread(providerSessionId, threadOptions);
    } else {
      thread = codex.startThread(threadOptions);
    }

    // One entry per run. It is filed again under the provider id once that is
    // known (legacy callers without an app id), and must stay the same object:
    // a fresh one would forget an abort that already landed.
    runEntry = {
      thread,
      codex,
      status: 'running',
      abortController,
      startedAt: new Date().toISOString()
    };
    const registerSession = (id: string | null) => {
      if (id && runEntry) {
        activeCodexSessions.set(id, runEntry);
      }
    };

    if (sessionKey()) {
      registerSession(sessionKey());
    }
    stopSignal?.addEventListener('abort', () => {
      if (runEntry?.status === 'running') {
        runEntry.status = 'aborted';
        abortController.abort();
      }
    }, { once: true });

    // Execute with streaming. Turns with image attachments send structured
    // input items so Codex reads the images from their local asset paths.
    const promptWithFiles = appendFilesInputTag(command, files);
    const normalizedImages = normalizeImageDescriptors(images);
    const promptWithImageFallback = !promptWithFiles.trim() && normalizedImages.length > 0
      ? CODEX_IMAGE_ONLY_PROMPT
      : promptWithFiles;
    const turnInput = normalizedImages.length > 0
      ? buildCodexInputItems(promptWithImageFallback, normalizedImages, workingDirectory)
      : promptWithFiles;
    const streamedTurn = await thread.runStreamed(turnInput, {
      signal: abortController.signal
    });

    for await (const event of streamedTurn.events) {
      // Capture thread/session id lazily from the stream (Codex emits this asynchronously).
      if (event.type === 'thread.started') {
        const discoveredSessionId = event.thread_id || null;
        if (discoveredSessionId && !capturedSessionId) {
          capturedSessionId = discoveredSessionId;
          registerSession(sessionKey());

          if (ws.setSessionId && typeof ws.setSessionId === 'function') {
            ws.setSessionId(capturedSessionId);
          }

          if (!providerSessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            sendMessage(ws, createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'codex' }));
          }
        }
      }

      // Check if session was aborted
      if (abortController.signal.aborted || runEntry.status === 'aborted') {
        break;
      }

      // `item.started`/`item.updated` of a running command, MCP call or plan
      // repeat the item id the `item.completed` will carry, so the client
      // store replaces its row on each tick instead of stacking new ones. That
      // id is the CLI's per-process counter (`item_0`, `item_1`, ...), not the
      // call id the rollout records, so the history refresh after `complete`
      // cannot match on it; the client drops a turn's live Codex tool rows once
      // the persisted transcript reaches past them. Text items are still
      // skipped mid-flight because assistant prose arrives through the
      // separate streaming path.
      if (
        (event.type === 'item.started' || event.type === 'item.updated')
        && !PROGRESSIVE_CODEX_ITEM_TYPES.has(event.item?.type)
      ) {
        continue;
      }

      const transformed = transformCodexEvent(event);
      if (transformed.type === 'error' || transformed.itemType === 'error') {
        errorSurfaced = true;
      }

      // Normalize the transformed event into NormalizedMessage(s) via adapter
      const normalizedMsgs = context.normalizeMessage(transformed, capturedSessionId || sessionId || null);
      for (const msg of normalizedMsgs) {
        // Same cap as history: a command's whole output is resent on every
        // progress tick, to every watching socket and into the replay buffer.
        if (msg.kind === 'tool_result' && typeof msg.content === 'string') {
          msg.content = truncateOutput(msg.content);
        }
        sendMessage(ws, msg);
      }

      if (event.type === 'turn.failed' && !terminalFailure) {
        terminalFailure = event.error || new Error('Turn failed');
        errorSurfaced = true;
        // Notifications are app-facing, so they carry the app session id.
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error: terminalFailure
        });
      }

      // Extract and send token usage if available (normalized to match Claude format)
      if (event.type === 'turn.completed') {
        const tokenBudget = extractCodexTokenBudget(event);
        if (tokenBudget) {
          sendMessage(ws, createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
        }
      }
    }

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const runAborted = runEntry.status === 'aborted' || abortController.signal.aborted;
    if (!runAborted) {
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        actualSessionId: capturedSessionId || thread.id || sessionId || null,
        exitCode: terminalFailure ? 1 : 0,
      }));
      if (!terminalFailure) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed'
        });
      }
    } else if (!terminalFailure) {
      notifyCodexRunAborted();
    }

  } catch (error) {
    const session = runEntry;
    const runError = error instanceof Error ? error : new Error(String(error));
    const wasAborted =
      session?.status === 'aborted' ||
      runError.name === 'AbortError' ||
      runError.message.toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);

      if (!errorSurfaced) {
        // Check if Codex SDK is available for a clearer error message
        const installed = await context.isProviderInstalled();
        const errorContent = !installed
          ? 'Codex CLI is not configured. Please set up authentication first.'
          : runError.message;

        sendMessage(ws, createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
      }
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        exitCode: 1,
      }));
      if (!terminalFailure) {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error
        });
      }
    } else if (!terminalFailure && (session?.status === 'aborted' || abortController.signal.aborted)) {
      // The SDK rethrows the spawn AbortError once the CLI is killed. Only a
      // real user abort counts; an error that merely mentions "aborted" stays
      // silent as before.
      notifyCodexRunAborted();
    }

  } finally {
    // The entry goes with the run, and only this run's: a later turn of the
    // session may already have filed its own under the same key.
    if (runEntry) {
      if (runEntry.status === 'running') {
        runEntry.status = 'completed';
      }
      for (const [key, entry] of activeCodexSessions) {
        if (entry === runEntry) {
          activeCodexSessions.delete(key);
        }
      }
    }
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
function abortCodexSession(sessionId: string) {
  const session = activeCodexSessions.get(sessionId);

  if (!session || session.status === 'completed') {
    return false;
  }

  session.status = 'aborted';
  try {
    session.abortController?.abort();
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return true;
}

/** Used by the providers module's CodexProvider to run and abort SDK turns. */
export const codexRuntime = {
  run: queryCodex,
  abort: abortCodexSession,
};

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws: ProviderRuntimeWriter, data: unknown) {
  try {
    if (ws.isWebSocketWriter) {
      // The gateway writer handles stringification
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}
