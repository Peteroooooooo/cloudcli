import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Which kind of program holds a live Claude process, from the `entrypoint`
 * Claude Code records for it: the VS Code extension, the CLI in a terminal
 * (CloudCLI's own Shell view included), or anything else built on Claude Code.
 */
export type ClaudeProcessHost = 'vscode' | 'cli' | 'other';

/**
 * One live Claude process that has a session open, busy or idle.
 *
 * `providerSessionId` is Claude's own session id, which is what the registry
 * records; callers map it onto an app session themselves.
 */
export type LiveClaudeProcess = {
  providerSessionId: string;
  host: ClaudeProcessHost;
  /** Producing a response right now, as opposed to waiting for input. */
  busy: boolean;
  /**
   * For a busy process, when its current turn began; otherwise when the
   * process started. The registry has no turn-start field, but it rewrites
   * `statusUpdatedAt` when the status flips to busy, which is that moment.
   */
  startedAt: number;
};

/**
 * Claude Code keeps one file per running session here, named `<pid>.json`.
 * The directory belongs to the CLI, not to CloudCLI: it is only ever read.
 */
const registryDirectory = () => path.join(os.homedir(), '.claude', 'sessions');

/**
 * Upper bound on registry files inspected per poll.
 *
 * The running-sessions endpoint is polled continuously, so a directory left
 * full of stale files by repeated crashes must not turn every poll into
 * unbounded filesystem work. Real installations hold a handful of entries.
 */
const MAX_REGISTRY_FILES = 256;

/**
 * The entrypoint CloudCLI's own chat runs register under (see
 * `buildClaudeSdkEnv`). Those processes are the chat-run registry's to report;
 * listing them here would show CloudCLI's own turns as happening elsewhere.
 */
const CLOUDCLI_ENTRYPOINT = 'claudecodeui';

function hostFromEntrypoint(entrypoint: unknown): ClaudeProcessHost {
  if (entrypoint === 'claude-vscode') {
    return 'vscode';
  }
  return entrypoint === 'cli' ? 'cli' : 'other';
}

/**
 * Whether `pid` is still the process the registry recorded.
 *
 * A registry file outlives a crash, so its mere presence proves nothing. The
 * signal-0 probe answers "does this pid exist" (EPERM means it exists but is
 * owned by someone else, which still counts), and on Linux the recorded
 * `procStart` is compared against the kernel's start-time for that pid so a
 * reused pid cannot be mistaken for the original process.
 */
async function isRecordedProcessAlive(pid: number, procStart: unknown): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EPERM') {
      return false;
    }
  }

  if (process.platform !== 'linux' || typeof procStart !== 'string' || !procStart) {
    return true;
  }

  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    // The comm field is parenthesised and may itself contain spaces, so the
    // fields are counted from the last ')'. starttime is the 22nd field
    // overall, i.e. the 20th of what follows the comm field.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] === procStart;
  } catch {
    // No procfs entry means the process is gone between the two checks.
    return false;
  }
}

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Reads one registry file, returning null for anything that is not a live process outside CloudCLI. */
async function readLiveProcess(filePath: string): Promise<LiveClaudeProcess | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    // Unreadable, half-written or malformed entries are simply not evidence
    // of a running session.
    return null;
  }

  const record = parsed as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') {
    return null;
  }

  const providerSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const pid = typeof record.pid === 'number' ? record.pid : NaN;
  if (!providerSessionId || !Number.isInteger(pid) || pid <= 0 || record.entrypoint === CLOUDCLI_ENTRYPOINT) {
    return null;
  }

  if (!(await isRecordedProcessAlive(pid, record.procStart))) {
    return null;
  }

  const busy = record.status === 'busy';
  const processStartedAt = finiteNumber(record.startedAt);
  const turnStartedAt = busy ? finiteNumber(record.statusUpdatedAt) : null;
  return {
    providerSessionId,
    host: hostFromEntrypoint(record.entrypoint),
    busy,
    startedAt: turnStartedAt ?? processStartedAt ?? Date.now(),
  };
}

/**
 * Lists the live Claude processes that have a session open, busy or idle,
 * other than CloudCLI's own chat runs.
 *
 * Used by the providers module's sessions service so the running-sessions poll
 * also reports turns driven outside CloudCLI's own chat runs, including the
 * `claude` processes CloudCLI itself spawns for the Shell view, which live in
 * the PTY map rather than the chat-run registry, and so the chat can warn that
 * a session is open in another process. Liveness is ephemeral, so it is
 * recomputed on every read instead of being cached or persisted.
 */
export async function listLiveClaudeProcesses(): Promise<LiveClaudeProcess[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(registryDirectory());
  } catch {
    // No registry directory at all is the normal case for an install that has
    // never run the CLI, and an unreadable one is not worth failing a poll for.
    return [];
  }

  const registryFiles = entries.filter((entry) => entry.endsWith('.json')).slice(0, MAX_REGISTRY_FILES);
  const processes = await Promise.all(
    registryFiles.map((entry) => readLiveProcess(path.join(registryDirectory(), entry))),
  );

  return processes.filter((live): live is LiveClaudeProcess => live !== null);
}
