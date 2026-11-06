import { open, stat, utimes } from 'node:fs/promises';

import { renameSession } from '@anthropic-ai/claude-agent-sdk';

import type { IProviderSessionTitle } from '@/shared/interfaces.js';

/**
 * How much of a transcript's end is read for its latest `/rename`.
 *
 * Claude re-appends the session's title lines (`custom-title`, `ai-title`,
 * `agent-name`) after every turn so its own session picker finds them in the
 * last few kilobytes. Reading only the end keeps a check on a 20 MB transcript
 * as cheap as one on a new one. A title that has scrolled out of this window
 * mid-turn is simply not seen: the caller keeps the name it already has.
 */
const TITLE_TAIL_BYTES = 64 * 1024;

/** The complete lines in the last `bytes` of a file, oldest first. */
async function readTailLines(filePath: string, bytes: number): Promise<string[]> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    // The first line is cut in half unless the window starts at the file's start.
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

type TitleEvents = { customTitle?: string; aiTitle?: string; hasAgentName: boolean };

async function readTitleEvents(filePath: string, sessionId: string): Promise<TitleEvents> {
  const events: TitleEvents = { hasAgentName: false };
  let lines: string[];
  try {
    lines = await readTailLines(filePath, TITLE_TAIL_BYTES);
  } catch {
    return events;
  }

  for (const line of lines) {
    // Cheap filter before JSON.parse: most lines in the window are messages.
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"') && !line.includes('"agent-name"')) {
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (data.sessionId !== sessionId) {
      continue;
    }
    if (data.type === 'custom-title' && typeof data.customTitle === 'string' && data.customTitle.trim()) {
      events.customTitle = data.customTitle;
    } else if (data.type === 'ai-title' && typeof data.aiTitle === 'string' && data.aiTitle.trim()) {
      events.aiTitle = data.aiTitle;
    } else if (data.type === 'agent-name') {
      events.hasAgentName = true;
    }
  }
  return events;
}

/**
 * The name the session was last given with `/rename` (or by CloudCLI, which
 * writes the same line), or undefined when none is near the end of the file.
 */
export async function readLatestCustomTitle(filePath: string, sessionId: string): Promise<string | undefined> {
  return (await readTitleEvents(filePath, sessionId)).customTitle;
}

/**
 * The title Claude Code itself shows for the session (its session picker and
 * the IDE tab): the last `/rename` if there is one, otherwise the title Claude
 * generated (`ai-title`), which it writes after the first reply and updates as
 * the conversation goes on. Undefined when neither is near the end of the file.
 */
export async function readClaudeShownTitle(filePath: string, sessionId: string): Promise<string | undefined> {
  const events = await readTitleEvents(filePath, sessionId);
  return events.customTitle ?? events.aiTitle;
}

/**
 * Names a Claude session the way `/rename` does, so `claude --resume` and the
 * IDE session list show the CloudCLI name.
 *
 * The SDK appends the `custom-title` line. Claude Code 2.1 also writes an
 * `agent-name` line on `/rename`; one is added only when the transcript already
 * has one, so a session never carries an old agent name beside a new title.
 *
 * The transcript's modification time is put back afterwards. A rename is not
 * activity in the conversation: without this the session would jump to the top
 * of every "recent" list, and the file watcher would report it as new activity.
 */
export class ClaudeSessionTitleProvider implements IProviderSessionTitle {
  async setTitle(input: { providerSessionId: string; jsonlPath: string | null; title: string }): Promise<void> {
    const before = input.jsonlPath ? await stat(input.jsonlPath).catch(() => null) : null;

    await renameSession(input.providerSessionId, input.title);

    if (!input.jsonlPath || !before) {
      return;
    }

    const { hasAgentName } = await readTitleEvents(input.jsonlPath, input.providerSessionId);
    if (hasAgentName) {
      const handle = await open(input.jsonlPath, 'a');
      try {
        await handle.write(`${JSON.stringify({
          type: 'agent-name',
          agentName: input.title.trim(),
          sessionId: input.providerSessionId,
        })}\n`);
      } finally {
        await handle.close();
      }
    }

    await utimes(input.jsonlPath, new Date(), before.mtime);
  }
}
