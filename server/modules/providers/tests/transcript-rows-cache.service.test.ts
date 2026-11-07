import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTranscriptRowsCache } from '@/modules/providers/services/transcript-rows-cache.service.js';
import type { AnyRecord } from '@/shared/types.js';

/**
 * A running session's transcript only ever grows by whole lines, so a second
 * read parses only what was appended. Anything else about the file (it shrank,
 * it was rewritten, a line is still being written) must read exactly what a
 * fresh parse of the file would.
 */

async function withFile(runTest: (filePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'transcript-rows-cache-'));
  try {
    await runTest(path.join(directory, 'session.jsonl'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const line = (row: AnyRecord): string => `${JSON.stringify(row)}\n`;

function countingKeep() {
  const seen: AnyRecord[] = [];
  return {
    seen,
    keep: (row: AnyRecord) => {
      seen.push(row);
      return row.keep !== false;
    },
  };
}

test('an appended file is parsed only past what was read before', async () => {
  await withFile(async (filePath) => {
    const cache = createTranscriptRowsCache();
    await writeFile(filePath, line({ n: 1 }) + line({ n: 2, keep: false }), 'utf8');
    const counter = countingKeep();

    const first = await cache.readRows({ filePath, filterKey: 's', keep: counter.keep });
    await appendFile(filePath, line({ n: 3 }), 'utf8');
    const second = await cache.readRows({ filePath, filterKey: 's', keep: counter.keep });

    assert.deepEqual(first.map((row) => row.n), [1]);
    assert.deepEqual(second.map((row) => row.n), [1, 3]);
    assert.deepEqual(counter.seen.map((row) => row.n), [1, 2, 3], 'rows 1 and 2 were not parsed twice');
    assert.equal(second[0], first[0], 'rows already read are reused');
  });
});

test('a line still being written is read again once it is finished', async () => {
  await withFile(async (filePath) => {
    const cache = createTranscriptRowsCache();
    await writeFile(filePath, `${line({ n: 1 })}{"n":2,"te`, 'utf8');

    const partial = await cache.readRows({ filePath, filterKey: 's', keep: () => true });
    await appendFile(filePath, 'xt":"done"}\n', 'utf8');
    const finished = await cache.readRows({ filePath, filterKey: 's', keep: () => true });

    assert.deepEqual(partial.map((row) => row.n), [1]);
    assert.deepEqual(finished, [{ n: 1 }, { n: 2, text: 'done' }]);
  });
});

test('a file that was rewritten is parsed from the start', async () => {
  await withFile(async (filePath) => {
    const cache = createTranscriptRowsCache();
    await writeFile(filePath, line({ n: 1, text: 'first' }), 'utf8');
    await cache.readRows({ filePath, filterKey: 's', keep: () => true });

    await writeFile(filePath, line({ n: 1, text: 'other' }) + line({ n: 2 }), 'utf8');
    const rewritten = await cache.readRows({ filePath, filterKey: 's', keep: () => true });

    assert.deepEqual(rewritten, [{ n: 1, text: 'other' }, { n: 2 }]);
  });
});

test('a file that shrank is parsed from the start', async () => {
  await withFile(async (filePath) => {
    const cache = createTranscriptRowsCache();
    await writeFile(filePath, line({ n: 1 }) + line({ n: 2 }), 'utf8');
    await cache.readRows({ filePath, filterKey: 's', keep: () => true });

    await writeFile(filePath, line({ n: 9 }), 'utf8');
    assert.deepEqual(await cache.readRows({ filePath, filterKey: 's', keep: () => true }), [{ n: 9 }]);
  });
});

test('a read with another filter does not reuse rows kept for the first', async () => {
  await withFile(async (filePath) => {
    const cache = createTranscriptRowsCache();
    await writeFile(filePath, line({ id: 'a' }) + line({ id: 'b' }), 'utf8');

    const onlyA = await cache.readRows({ filePath, filterKey: 'a', keep: (row) => row.id === 'a' });
    const onlyB = await cache.readRows({ filePath, filterKey: 'b', keep: (row) => row.id === 'b' });

    assert.deepEqual(onlyA, [{ id: 'a' }]);
    assert.deepEqual(onlyB, [{ id: 'b' }]);
  });
});

test('rows split across read chunks, CRLF endings and blank lines parse as usual', async () => {
  await withFile(async (filePath) => {
    const cache = createTranscriptRowsCache();
    const big = 'x'.repeat(5 * 1024 * 1024);
    await writeFile(filePath, `${JSON.stringify({ n: 1, big })}\r\n\n  \n${line({ n: 2 })}not json\n`, 'utf8');

    const rows = await cache.readRows({ filePath, filterKey: 's', keep: () => true });

    assert.deepEqual(rows.map((row) => row.n), [1, 2]);
    assert.equal(rows[0].big.length, big.length);
  });
});

test('callers cannot change the cached row list', async () => {
  await withFile(async (filePath) => {
    const cache = createTranscriptRowsCache();
    await writeFile(filePath, line({ n: 1 }), 'utf8');

    const first = await cache.readRows({ filePath, filterKey: 's', keep: () => true });
    first.pop();
    const second = await cache.readRows({ filePath, filterKey: 's', keep: () => true });

    assert.equal(second.length, 1);
  });
});
