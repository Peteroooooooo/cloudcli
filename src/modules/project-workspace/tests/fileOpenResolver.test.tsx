import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard: an absolute path must open the file it names.
 *
 * `findBestMatch` falls back to matching by filename, which is what makes bare
 * references like `foo.ts` work. Applied to an absolute path it silently
 * rewrote the reference: asking for `/home/user/.config/CLAUDE.md` opened the
 * project's own `CLAUDE.md` — a different file, with no error, indistinguishable
 * from the right one.
 */

const searchFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { searchFiles: (...args: unknown[]) => searchFiles(...args) },
}));

const { useFileOpenResolver } = await import('@/modules/project-workspace/hooks/useFileOpenResolver');

const ROOT = '/home/odoo/workspace/personal';
const project: Project = { projectId: 'p1', displayName: 'personal', fullPath: ROOT };

const files = [
  { type: 'file', name: 'CLAUDE.md', path: `${ROOT}/CLAUDE.md`, relativePath: 'CLAUDE.md' },
  { type: 'file', name: 'foo.ts', path: `${ROOT}/src/foo.ts`, relativePath: 'src/foo.ts' },
];

// The server's `basename` search: files whose whole name equals the query.
const answerSearch = async (_projectId: string, { q }: { q: string }) => ({
  ok: true,
  json: async () => ({
    results: files.filter((file) => file.name.toLowerCase() === q.toLowerCase()),
    truncated: false,
  }),
});

const setup = () => {
  searchFiles.mockReset();
  searchFiles.mockImplementation(answerSearch);
  const onFileOpen = vi.fn();
  const { result } = renderHook(() => useFileOpenResolver(project, onFileOpen));
  return { resolve: result.current, onFileOpen };
};

test('an absolute path outside the project is passed through untouched', async () => {
  const { resolve, onFileOpen } = setup();
  resolve('/home/odoo/.claude/CLAUDE.md');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], '/home/odoo/.claude/CLAUDE.md');
  // It does not even need the tree, so no request goes out.
  assert.equal(searchFiles.mock.calls.length, 0);
});

test('an absolute path inside the project resolves to itself, as before', async () => {
  const { resolve, onFileOpen } = setup();
  resolve(`${ROOT}/src/foo.ts`);
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);
});

test('partial references still match against the tree', async () => {
  const { resolve, onFileOpen } = setup();
  resolve('foo.ts');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);

  const second = setup();
  second.resolve('src/foo.ts');
  await waitFor(() => assert.equal(second.onFileOpen.mock.calls.length, 1));
  assert.equal(second.onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);

  // Only files with the reference's name are asked for.
  assert.deepEqual(searchFiles.mock.calls[0][1], { q: 'foo.ts', match: 'basename', filesOnly: true, limit: 200 });
});

test('diffInfo and line survive the absolute-path shortcut', async () => {
  const { resolve, onFileOpen } = setup();
  const diffInfo = { old_string: 'a', new_string: 'b' };
  resolve('/home/odoo/.claude/CLAUDE.md', diffInfo, 150);
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.deepEqual(onFileOpen.mock.calls[0].slice(1), [diffInfo, 150]);
});

test('surrounding whitespace never reaches the API as part of the path', async () => {
  const { resolve, onFileOpen } = setup();
  resolve('  /home/odoo/.claude/CLAUDE.md ');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], '/home/odoo/.claude/CLAUDE.md');

  const second = setup();
  second.resolve('nope.ts ');
  await waitFor(() => assert.equal(second.onFileOpen.mock.calls.length, 1));
  assert.equal(second.onFileOpen.mock.calls[0][0], 'nope.ts');
});
