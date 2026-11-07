import fsp from 'node:fs/promises';

import type { AnyRecord } from '@/shared/types.js';

/**
 * Parsed-row cache for append-only JSONL transcripts.
 *
 * A session that is still running grows its transcript with every step, and
 * every history request after a step used to read and `JSON.parse` the whole
 * file again. For a long session that is hundreds of megabytes (one measured
 * Claude transcript: 316 MB, 17k rows, about a second per read), paid on every
 * page the client asks for while the agent is writing.
 *
 * The writers only ever append whole lines, so the rows already parsed stay
 * valid: an entry remembers the byte offset its last complete line ended at,
 * and a later read parses only what was written after it. Before trusting
 * that, the bytes just before the offset are compared with the ones read last
 * time; a file that shrank or was rewritten is parsed from the start.
 *
 * Callers receive a fresh array, but the row objects in it are shared with the
 * cache and with every later read. A caller that writes onto a row must write
 * the same value each time it sees that row.
 */

type CacheEntry = {
  /** Which rows the entry kept; a read with a different key starts over. */
  filterKey: string;
  mtimeMs: number;
  size: number;
  /** Byte offset just past the last line that was consumed. */
  endOffset: number;
  /** The bytes right before `endOffset`, used to detect a rewritten file. */
  probe: Buffer;
  rows: AnyRecord[];
};

type ReadRowsArgs = {
  filePath: string;
  /** Identifies `keep`; entries are only reused by a read with the same key. */
  filterKey: string;
  /** Decides which parsed rows are kept. Must depend on nothing but the row. */
  keep: (row: AnyRecord) => boolean;
};

const PROBE_BYTES = 256;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * The parsed rows weigh about as much as the file they came from, so the budget
 * is in file bytes. The newest entry is kept even when it alone is over budget;
 * dropping it would only make the next read parse the same file again.
 */
const MAX_CACHED_FILE_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 4;

function isBlank(buffer: Buffer, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const byte = buffer[index];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== NEWLINE) {
      return false;
    }
  }
  return true;
}

/**
 * Parses the lines in `[startOffset, size)` and pushes the kept rows onto
 * `rows`. Returns the offset just past the last line consumed. A final line
 * with no newline is consumed only when it parses: the writer may still be in
 * the middle of it, and it is read again next time.
 */
async function parseLines(
  filePath: string,
  startOffset: number,
  size: number,
  keep: (row: AnyRecord) => boolean,
  rows: AnyRecord[],
): Promise<number> {
  const handle = await fsp.open(filePath, 'r');
  try {
    let position = startOffset;
    let carry: Buffer = Buffer.alloc(0);
    // Offset in the file of carry[0].
    let carryStart = startOffset;

    const consume = (buffer: Buffer, start: number, end: number): boolean => {
      if (isBlank(buffer, start, end)) {
        return true;
      }
      try {
        const row = JSON.parse(buffer.toString('utf8', start, end)) as AnyRecord;
        if (keep(row)) {
          rows.push(row);
        }
        return true;
      } catch {
        return false;
      }
    };

    while (position < size) {
      const length = Math.min(READ_CHUNK_BYTES, size - position);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;

      const buffer = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let lineStart = 0;
      let newline = buffer.indexOf(NEWLINE, lineStart);
      while (newline !== -1) {
        // A complete line that does not parse is damaged, not unfinished; it
        // is skipped like the line-by-line reader always did.
        consume(buffer, lineStart, newline);
        lineStart = newline + 1;
        newline = buffer.indexOf(NEWLINE, lineStart);
      }
      carryStart += lineStart;
      carry = Buffer.from(buffer.subarray(lineStart));
    }

    if (carry.length > 0 && consume(carry, 0, carry.length)) {
      return carryStart + carry.length;
    }
    return carryStart;
  } finally {
    await handle.close();
  }
}

async function readProbe(filePath: string, endOffset: number): Promise<Buffer> {
  const length = Math.min(PROBE_BYTES, endOffset);
  const probe = Buffer.alloc(length);
  if (length === 0) {
    return probe;
  }
  const handle = await fsp.open(filePath, 'r');
  try {
    const { bytesRead } = await handle.read(probe, 0, length, endOffset - length);
    return probe.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Builds a row cache. Exported for this module's tests, which need a fresh
 * instance each; the providers use `transcriptRowsCache` below.
 */
export function createTranscriptRowsCache(
  maxTotalFileBytes = MAX_CACHED_FILE_BYTES,
  maxEntries = MAX_CACHE_ENTRIES,
) {
  const entries = new Map<string, CacheEntry>();
  // Reads of one file run one after another, so a read never extends an entry
  // another read is still extending.
  const busy = new Map<string, Promise<unknown>>();

  function evictOverBudget(): void {
    let totalBytes = 0;
    for (const entry of entries.values()) {
      totalBytes += entry.size;
    }
    for (const key of entries.keys()) {
      if (entries.size <= 1 || (totalBytes <= maxTotalFileBytes && entries.size <= maxEntries)) {
        break;
      }
      totalBytes -= entries.get(key)!.size;
      entries.delete(key);
    }
  }

  async function read({ filePath, filterKey, keep }: ReadRowsArgs): Promise<AnyRecord[]> {
    const stat = await fsp.stat(filePath);
    const cached = entries.get(filePath);
    entries.delete(filePath);

    let entry: CacheEntry | undefined;
    if (cached && cached.filterKey === filterKey && stat.size >= cached.endOffset) {
      if (cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        entry = cached;
      } else if ((await readProbe(filePath, cached.endOffset)).equals(cached.probe)) {
        const rows = cached.rows;
        const endOffset = await parseLines(filePath, cached.endOffset, stat.size, keep, rows);
        entry = {
          ...cached,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          endOffset,
          probe: endOffset === cached.endOffset ? cached.probe : await readProbe(filePath, endOffset),
        };
      }
    }

    if (!entry) {
      const rows: AnyRecord[] = [];
      const endOffset = await parseLines(filePath, 0, stat.size, keep, rows);
      entry = {
        filterKey,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        endOffset,
        probe: await readProbe(filePath, endOffset),
        rows,
      };
    }

    entries.set(filePath, entry);
    evictOverBudget();
    return entry.rows.slice();
  }

  return {
    /**
     * Returns every kept row of the file in file order. Throws when the file
     * cannot be read, like a plain read would.
     */
    async readRows(args: ReadRowsArgs): Promise<AnyRecord[]> {
      const previous = busy.get(args.filePath) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(() => read(args));
      busy.set(args.filePath, current);
      try {
        return await current;
      } finally {
        if (busy.get(args.filePath) === current) {
          busy.delete(args.filePath);
        }
      }
    },
  };
}

/**
 * Used by the Claude sessions provider to read a session's transcript rows, so
 * a running session's growing file is parsed only past what was read before.
 */
export const transcriptRowsCache = createTranscriptRowsCache();
