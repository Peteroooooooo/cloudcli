import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

/**
 * The palette opens on the project's first files in tree order, as before,
 * and also asks the server for the typed text, so a file past those first 500
 * in a large project can still be found.
 */

const searchFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { searchFiles: (...args: unknown[]) => searchFiles(...args) },
}));

const { useFilesSource } = await import('@/modules/command-palette/hooks/useFilesSource');

const ROOT = '/projects/big';
const hit = (relativePath: string) => ({
  type: 'file',
  name: relativePath.split('/').pop(),
  path: `${ROOT}/${relativePath}`,
  relativePath,
});

const answer = async (_projectId: string, { q }: { q: string }) => ({
  ok: true,
  json: async () => ({
    results: q ? [hit('deep/logo-128.png'), hit('a.ts')] : [hit('a.ts'), hit('b.ts')],
    truncated: !q,
  }),
});

test('the first files load on open and typed text adds server matches', async () => {
  searchFiles.mockReset();
  searchFiles.mockImplementation(answer);

  const { result, rerender } = renderHook(
    ({ search }: { search: string }) => useFilesSource('p1', true, search),
    { initialProps: { search: '' } },
  );

  await waitFor(() => assert.deepEqual(result.current.map((file) => file.name), ['a.ts', 'b.ts']));
  assert.deepEqual(searchFiles.mock.calls[0][1], { q: '', filesOnly: true, limit: 500 });

  rerender({ search: 'logo-128' });
  // Server matches lead, so the palette's short main-page list shows them.
  await waitFor(() => assert.deepEqual(result.current.map((file) => file.name), ['logo-128.png', 'a.ts', 'b.ts']));
  assert.deepEqual(searchFiles.mock.calls[1][1], { q: 'logo-128', filesOnly: true, limit: 100 });
  assert.equal(result.current[0].path, `${ROOT}/deep/logo-128.png`);
});

test('nothing is fetched while the files section is hidden', async () => {
  searchFiles.mockReset();
  searchFiles.mockImplementation(answer);

  const { result } = renderHook(() => useFilesSource('p1', false, 'logo'));
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 300));

  assert.deepEqual(result.current, []);
  assert.equal(searchFiles.mock.calls.length, 0);
});
