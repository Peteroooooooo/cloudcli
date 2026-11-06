import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useVersionCheck } from '@/shared/hooks/useVersionCheck';

/**
 * A git checkout of this fork used to poll the upstream GitHub releases every
 * five minutes per mounted hook and offer an "update" that switched the
 * checkout to upstream main. Only npm installs look for releases now.
 */

const RELEASES_URL = 'https://api.github.com/repos/siteboon/claudecodeui/releases/latest';

const stubFetch = (installMode: 'git' | 'npm') => {
  const fetchMock = vi.fn(async (url: string) => ({
    json: async () => (url === '/health'
      ? { installMode, version: null }
      : { tag_name: 'v999.0.0', name: 'v999.0.0', body: '', html_url: 'https://example.invalid/release' }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const releaseChecks = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([url]) => url === RELEASES_URL).length;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a git install never asks GitHub for releases and reports no update', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetchMock = stubFetch('git');

  const { result } = renderHook(() => useVersionCheck('siteboon', 'claudecodeui'));
  await waitFor(() => assert.ok(fetchMock.mock.calls.some(([url]) => url === '/health')));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
  });

  assert.equal(releaseChecks(fetchMock), 0);
  assert.equal(result.current.updateAvailable, false);
  assert.equal(result.current.latestVersion, null);
  assert.equal(result.current.installMode, 'git');
});

test('an npm install still checks the releases and reports a newer one', async () => {
  const fetchMock = stubFetch('npm');

  const { result } = renderHook(() => useVersionCheck('siteboon', 'claudecodeui'));

  await waitFor(() => assert.equal(result.current.updateAvailable, true));
  assert.equal(result.current.latestVersion, '999.0.0');
  assert.equal(result.current.installMode, 'npm');
  assert.equal(releaseChecks(fetchMock), 1);
});
