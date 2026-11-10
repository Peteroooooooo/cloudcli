import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent, RefObject } from 'react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * The `@` picker asks the server for every query, so it works in a project of
 * any size. Regression guards carried over from the in-memory list: a file
 * added after the composer opened (#1367) is found, an older answer never
 * overwrites a newer one, and a dismissed dropdown stays dismissed.
 */

const searchFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { searchFiles: (...args: unknown[]) => searchFiles(...args) },
}));

const { useFileMentions } = await import('@/modules/chat/hooks/useFileMentions');

const ROOT = '/home/user/project';
const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT };

const result = (relativePath: string) => ({
  type: 'file',
  name: relativePath.split('/').pop(),
  path: `${ROOT}/${relativePath}`,
  relativePath,
});
const searchResponse = (relativePaths: string[]) => ({
  ok: true,
  json: async () => ({ results: relativePaths.map(result), truncated: false }),
});

// The project as the fake server sees it; tests add files to it.
let projectFiles: string[] = [];
const answerFromProject = async (_projectId: string, { q }: { q: string }) =>
  searchResponse(projectFiles.filter((file) => file.toLowerCase().includes(q.toLowerCase())).slice(0, 10));

// A search response the test resolves by hand, to hold a request in flight.
const deferredSearchResponse = () => {
  let resolve: (relativePaths: string[]) => void = () => {};
  const promise = new Promise<ReturnType<typeof searchResponse>>((resolvePromise) => {
    resolve = (relativePaths) => resolvePromise(searchResponse(relativePaths));
  });
  return { promise, resolve };
};

const keyEvent = (key: string) =>
  ({ key, preventDefault: () => {} }) as unknown as KeyboardEvent<HTMLTextAreaElement>;

const queriesSent = () => searchFiles.mock.calls.map((call) => (call[1] as { q: string }).q);

const renderMentions = () => {
  const textareaRef: RefObject<HTMLTextAreaElement> = { current: null };
  const hook = renderHook(
    ({ input }: { input: string }) =>
      useFileMentions({ selectedProject: project, input, setInput: vi.fn(), textareaRef }),
    { initialProps: { input: '' } },
  );

  // Mirrors the composer: the input changes and the caret follows it.
  const type = (input: string) => {
    hook.rerender({ input });
    act(() => {
      hook.result.current.setCursorPosition(input.length);
    });
  };

  const shownNames = () => hook.result.current.filteredFiles.map((file) => file.name);

  return { ...hook, type, shownNames };
};

const setup = () => {
  searchFiles.mockReset();
  projectFiles = ['a.txt', 'b.txt', 'docs/logo.png'];
  searchFiles.mockImplementation(answerFromProject);
};

test('nothing is fetched until `@` is typed, and the query goes to the server', async () => {
  setup();
  const { result, type, shownNames } = renderMentions();
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 150));
  assert.equal(searchFiles.mock.calls.length, 0);

  type('look at @logo');
  await waitFor(() => assert.deepEqual(shownNames(), ['logo.png']));
  assert.deepEqual(queriesSent(), ['logo']);
  assert.deepEqual(searchFiles.mock.calls[0][1], { q: 'logo', match: 'path', filesOnly: true, limit: 10 });
  // The project-relative path is what a selection inserts.
  assert.equal(result.current.filteredFiles[0].path, 'docs/logo.png');
});

test('a file added after the composer opened is found by the next search (#1367)', async () => {
  setup();
  const { type, shownNames } = renderMentions();

  type('@upl');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  assert.deepEqual(shownNames(), []);

  projectFiles = [...projectFiles, 'uploaded.txt'];
  type('@upl ');
  type('@upl @upl');
  await waitFor(() => assert.deepEqual(shownNames(), ['uploaded.txt']));
});

test('typing fast sends one search after the pause, not one per keystroke', async () => {
  setup();
  const { type, shownNames } = renderMentions();

  type('@');
  type('@a');
  type('@a.');
  type('@a.t');

  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));
  assert.deepEqual(queriesSent(), ['a.t']);
});

test('earlier matches narrowed to the new query stay visible while it is searched', async () => {
  setup();
  const { type, shownNames } = renderMentions();

  type('@.txt');
  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt', 'b.txt']));

  const pending = deferredSearchResponse();
  searchFiles.mockReturnValueOnce(pending.promise);
  type('@b.txt');
  // Narrowed locally at once; never a file that no longer matches.
  assert.deepEqual(shownNames(), ['b.txt']);
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));

  await act(async () => {
    pending.resolve(['b.txt', 'sub/b.txt']);
  });
  await waitFor(() => assert.deepEqual(shownNames(), ['b.txt', 'b.txt']));
});

test('an older search that lands after a newer one cannot overwrite it', async () => {
  setup();
  const olderSearch = deferredSearchResponse();
  const newerSearch = deferredSearchResponse();
  searchFiles.mockReturnValueOnce(olderSearch.promise);
  searchFiles.mockReturnValueOnce(newerSearch.promise);

  const { type, shownNames } = renderMentions();

  type('@n');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  type('@ne');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));

  // The newer request superseded the older one.
  const olderSignal = (searchFiles.mock.calls[0][2] as { signal: AbortSignal }).signal;
  assert.equal(olderSignal.aborted, true);

  await act(async () => {
    newerSearch.resolve(['newer.txt']);
  });
  await waitFor(() => assert.deepEqual(shownNames(), ['newer.txt']));

  await act(async () => {
    olderSearch.resolve(['older-n.txt']);
  });
  assert.deepEqual(shownNames(), ['newer.txt']);
});

test('a search that lands after Escape dismissed the dropdown does not re-open it', async () => {
  setup();
  const { result, type, shownNames } = renderMentions();

  type('mail me at foo@a');
  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));

  const pending = deferredSearchResponse();
  searchFiles.mockReturnValueOnce(pending.promise);
  type('mail me at foo@a.');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));
  assert.equal(result.current.showFileDropdown, true);

  act(() => {
    result.current.handleFileMentionsKeyDown(keyEvent('Escape'));
  });
  assert.equal(result.current.showFileDropdown, false);
  const droppedSignal = (searchFiles.mock.calls[1][2] as { signal: AbortSignal }).signal;
  assert.equal(droppedSignal.aborted, true);

  await act(async () => {
    pending.resolve(['a.txt', 'a.new.txt']);
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
  });

  // Still dismissed, so the next Enter reaches the composer and sends the message.
  assert.equal(result.current.showFileDropdown, false);
  let enterHandled = true;
  act(() => {
    enterHandled = result.current.handleFileMentionsKeyDown(keyEvent('Enter'));
  });
  assert.equal(enterHandled, false);

  // Typing on inside the query re-opens the dropdown and searches again.
  type('mail me at foo@a.t');
  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));
  assert.equal(result.current.showFileDropdown, true);
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 3));
});

test('Escape before the first search was sent cancels it', async () => {
  setup();
  const { result, type } = renderMentions();

  type('mail foo@zz');
  act(() => {
    result.current.handleFileMentionsKeyDown(keyEvent('Escape'));
  });
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 200));

  assert.equal(result.current.showFileDropdown, false);
  assert.equal(searchFiles.mock.calls.length, 0);
  let enterHandled = true;
  act(() => {
    enterHandled = result.current.handleFileMentionsKeyDown(keyEvent('Enter'));
  });
  assert.equal(enterHandled, false);
});
