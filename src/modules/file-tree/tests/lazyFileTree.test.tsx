import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * The Files tab loads a project one folder at a time: opening it lists only
 * the root, expanding a folder fetches that folder once, a huge folder shows a
 * page plus a "show more" row, the search box asks the server, and a file
 * operation re-reads only the folder it touched.
 */

const ROOT = '/projects/big';

type Entry = { type: 'file' | 'directory'; name: string; path: string };

const entry = (type: Entry['type'], relativePath: string): Entry => ({
  type,
  name: relativePath.split('/').pop() ?? relativePath,
  path: `${ROOT}/${relativePath}`,
});

// `data/raw` holds more children than one page.
const rawChildren = Array.from({ length: 1_200 }, (_, index) => entry('file', `data/raw/part-${String(index).padStart(4, '0')}.csv`));
const listings: Record<string, Entry[]> = {
  '': [entry('directory', 'data'), entry('directory', 'src'), entry('file', 'README.md')],
  [`${ROOT}/data`]: [entry('directory', 'data/raw')],
  [`${ROOT}/data/raw`]: rawChildren,
  [`${ROOT}/src`]: [entry('file', 'src/main.ts')],
};

const listDirectory = vi.fn(async (
  _projectId: string,
  { path, offset = 0, limit = 500 }: { path?: string | null; offset?: number; limit?: number } = {},
) => {
  const all = listings[path ?? ''] ?? [];
  const entries = all.slice(offset, offset + limit);
  return {
    ok: true,
    json: async () => ({
      path: path ?? ROOT,
      entries,
      total: all.length,
      offset,
      hasMore: offset + entries.length < all.length,
      truncated: false,
    }),
  };
});

const searchFiles = vi.fn(async (_projectId: string, _params: { q: string; match?: string; limit?: number }) => ({
  ok: true,
  json: async () => ({
    results: [{ ...entry('file', 'src/main.ts'), relativePath: 'src/main.ts' }],
    truncated: true,
  }),
}));

const createFile = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
const deleteFile = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));

vi.mock('@/shared/api', () => ({
  api: {
    listDirectory: (...args: Parameters<typeof listDirectory>) => listDirectory(...args),
    searchFiles: (...args: Parameters<typeof searchFiles>) => searchFiles(...args),
    createFile: (...args: unknown[]) => createFile(...(args as [])),
    deleteFile: (...args: unknown[]) => deleteFile(...(args as [])),
  },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'big', fullPath: ROOT, path: ROOT };

const requestedPaths = () => listDirectory.mock.calls.map((call) => call[1]?.path ?? null);

test('opening the tab lists only the root, and a folder is fetched once when expanded', async () => {
  listDirectory.mockClear();
  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText('README.md')));
  assert.deepEqual(requestedPaths(), [null]);

  fireEvent.click(screen.getByText('src'));
  await waitFor(() => assert.ok(screen.getByText('main.ts')));
  assert.deepEqual(requestedPaths(), [null, `${ROOT}/src`]);

  // Folding and unfolding again is served from the cache.
  fireEvent.click(screen.getByText('src'));
  await waitFor(() => assert.equal(screen.queryByText('main.ts'), null));
  fireEvent.click(screen.getByText('src'));
  await waitFor(() => assert.ok(screen.getByText('main.ts')));
  assert.equal(listDirectory.mock.calls.length, 2);
});

test('a folder with more children than a page shows a page and a show-more row', async () => {
  listDirectory.mockClear();
  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText('data')));
  fireEvent.click(screen.getByText('data'));
  await waitFor(() => assert.ok(screen.getByText('raw')));
  fireEvent.click(screen.getByText('raw'));

  await waitFor(() => assert.ok(screen.getByText('part-0499.csv')));
  assert.equal(screen.queryByText('part-0500.csv'), null);

  fireEvent.click(screen.getByRole('button', { name: /show more/i }));
  await waitFor(() => assert.ok(screen.getByText('part-0999.csv')));
  const pageRequest = listDirectory.mock.calls.at(-1)?.[1];
  assert.equal(pageRequest?.path, `${ROOT}/data/raw`);
  assert.equal(pageRequest?.offset, 500);
  // The first page is still there, once.
  assert.equal(screen.getAllByText('part-0000.csv').length, 1);
});

test('the search box asks the server and shows the hits inside their folders', async () => {
  searchFiles.mockClear();
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('README.md')));

  fireEvent.change(screen.getByPlaceholderText(/./), { target: { value: 'main' } });

  await waitFor(() => assert.ok(screen.getByText('main.ts')));
  assert.equal(searchFiles.mock.calls.length, 1);
  assert.equal(searchFiles.mock.calls[0][1].q, 'main');
  assert.equal(searchFiles.mock.calls[0][1].match, 'name');
  // The ancestor folder is rebuilt around the hit, and other root entries are hidden.
  assert.ok(screen.getByText('src'));
  assert.equal(screen.queryByText('README.md'), null);
  assert.ok(screen.getByText(/more matches were not shown/i));

  // Clearing the search brings the tree back as it was.
  fireEvent.change(screen.getByPlaceholderText(/./), { target: { value: '' } });
  await waitFor(() => assert.ok(screen.getByText('README.md')));
  assert.equal(screen.queryByText('main.ts'), null);
});

test('creating a file re-reads only the folder it was created in', async () => {
  listDirectory.mockClear();
  createFile.mockClear();
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('README.md')));
  fireEvent.click(screen.getByText('src'));
  await waitFor(() => assert.ok(screen.getByText('main.ts')));
  const callsBefore = listDirectory.mock.calls.length;

  fireEvent.click(screen.getByRole('button', { name: /new file/i }));
  const nameInput = await screen.findByDisplayValue('untitled.txt');
  fireEvent.keyDown(nameInput, { key: 'Enter' });

  await waitFor(() => assert.equal(createFile.mock.calls.length, 1));
  await waitFor(() => assert.equal(listDirectory.mock.calls.length, callsBefore + 1));
  // The root again; the open `src` folder was not re-read.
  assert.equal(listDirectory.mock.calls.at(-1)?.[1]?.path ?? null, null);
});

test('deleting an open folder re-reads its parent and never asks for the folder again', async () => {
  listDirectory.mockClear();
  deleteFile.mockClear();
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('README.md')));
  fireEvent.click(screen.getByText('src'));
  await waitFor(() => assert.ok(screen.getByText('main.ts')));

  const originalRoot = listings[''];
  listings[''] = originalRoot.filter((item) => item.name !== 'src');
  try {
    fireEvent.contextMenu(screen.getByText('src'));
    fireEvent.click(await screen.findByText('Delete'));
    const confirmButton = screen.getAllByRole('button', { name: 'Delete' }).at(-1);
    assert.ok(confirmButton);
    fireEvent.click(confirmButton);

    await waitFor(() => assert.equal(deleteFile.mock.calls.length, 1));
    await waitFor(() => assert.equal(screen.queryByText('src'), null));
    assert.equal(screen.queryByText('main.ts'), null);
    // The root twice and `src` once; the deleted folder is never fetched again.
    assert.deepEqual(requestedPaths(), [null, `${ROOT}/src`, null]);
  } finally {
    listings[''] = originalRoot;
  }
});
