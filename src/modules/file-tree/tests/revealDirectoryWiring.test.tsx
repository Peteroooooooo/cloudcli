import assert from 'node:assert/strict';

import { render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard for the wiring, not the maths: a directory reference clicked
 * in the chat reaches the tree as the model wrote it — relative to the project
 * root — while every node here is keyed by its absolute path. Rendering the
 * real tree is what proves the two ends still meet, now that each folder is
 * only fetched once it is expanded.
 */

const ROOT = '/home/odoo/workspace/personal';

const node = (type: 'file' | 'directory', relativePath: string) => ({
  type,
  name: relativePath.split('/').pop(),
  path: `${ROOT}/${relativePath}`,
});

const listings: Record<string, ReturnType<typeof node>[]> = {
  '': [node('directory', 'decisions'), node('directory', 'src')],
  [`${ROOT}/decisions`]: [node('file', 'decisions/0001-first.md')],
  [`${ROOT}/src`]: [node('directory', 'src/modules')],
  [`${ROOT}/src/modules`]: [node('file', 'src/modules/index.ts')],
};

const listDirectory = vi.fn(async (_projectId: string, { path }: { path?: string | null } = {}) => {
  const entries = listings[path ?? ''] ?? [];
  return {
    ok: true,
    json: async () => ({ path: path ?? ROOT, entries, total: entries.length, offset: 0, hasMore: false, truncated: false }),
  };
});

vi.mock('@/shared/api', () => ({
  api: {
    listDirectory: (...args: Parameters<typeof listDirectory>) => listDirectory(...args),
  },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'personal', fullPath: ROOT, path: ROOT };

test('a relative directory reference expands that folder in the tree', async () => {
  render(<FileTree selectedProject={project} revealDirectory={{ path: 'decisions/' }} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  // Visible only because the folder was expanded (and so fetched) for us.
  await waitFor(() => assert.ok(screen.getByText('0001-first.md')));
});

test('a nested reference opens every level as each one loads', async () => {
  render(<FileTree selectedProject={project} revealDirectory={{ path: 'src/modules/' }} />);

  await waitFor(() => assert.ok(screen.getByText('index.ts')));
});

test('a folder nobody asked for stays closed and is never fetched', async () => {
  listDirectory.mockClear();
  render(<FileTree selectedProject={project} revealDirectory={null} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  assert.equal(screen.queryByText('0001-first.md'), null);
  assert.deepEqual(listDirectory.mock.calls.map((call) => call[1]?.path ?? null), [null]);
});
