import assert from 'node:assert/strict';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import '@/modules/i18n';

/**
 * Startup asked whether setup is needed, then who the token belongs to, then
 * whether onboarding is done, one after another: three round trips before the
 * workspace could mount. With a stored token they are now asked together, and
 * every outcome must stay what it was when they were asked in turn.
 */

const makeToken = () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ userId: 1, username: 'peter', iat: now, exp: now + 7 * 86400 })}.sig`;
};

type Reply = { status?: number; body: unknown; authError?: boolean };

let started: string[] = [];
let events: string[] = [];
let replies: Record<string, Reply> = {};

const stubServer = () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    started.push(url);
    events.push(`start ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push(`end ${url}`);
    const reply = replies[url] ?? { body: {} };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (reply.authError) headers['X-Auth-Error'] = 'invalid';
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers });
  }));
};

function Gate() {
  const { isLoading, user, needsSetup, hasCompletedOnboarding, error } = useAuth();
  if (isLoading) return <div>loading</div>;
  const errorText = error ? ` error:${error}` : '';
  if (needsSetup) return <div>{`setup${errorText}`}</div>;
  if (!user) return <div>{`login${errorText}`}</div>;
  return <div>{hasCompletedOnboarding ? `workspace ${user.username}` : 'onboarding'}</div>;
}

beforeEach(() => {
  started = [];
  events = [];
  replies = {
    '/api/auth/status': { body: { needsSetup: false } },
    '/api/auth/user': { body: { user: { id: 1, username: 'peter' } } },
    '/api/user/onboarding-status': { body: { hasCompletedOnboarding: true } },
  };
  localStorage.setItem('auth-token', makeToken());
  stubServer();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const startupRequests = () => started.filter((url) => url.startsWith('/api/auth/') || url === '/api/user/onboarding-status');

test('with a stored token the three startup questions are asked before the first answer', async () => {
  render(<AuthProvider><Gate /></AuthProvider>);

  await screen.findByText('workspace peter');
  assert.deepEqual(startupRequests(), ['/api/auth/status', '/api/auth/user', '/api/user/onboarding-status']);
  const firstAnswer = events.findIndex((event) => event.startsWith('end '));
  assert.deepEqual(events.slice(0, firstAnswer), [
    'start /api/auth/status',
    'start /api/auth/user',
    'start /api/user/onboarding-status',
  ]);
});

test('a user who has not onboarded still lands on onboarding', async () => {
  replies['/api/user/onboarding-status'] = { body: { hasCompletedOnboarding: false } };
  render(<AuthProvider><Gate /></AuthProvider>);
  await screen.findByText('onboarding');
});

test('a rejected token ends on the sign-in screen', async () => {
  replies['/api/auth/user'] = { status: 401, authError: true, body: { error: 'invalid token' } };
  replies['/api/user/onboarding-status'] = { status: 401, authError: true, body: { error: 'invalid token' } };
  render(<AuthProvider><Gate /></AuthProvider>);

  await waitFor(() => assert.match(document.body.textContent ?? '', /^login/));
  assert.equal(localStorage.getItem('auth-token'), null);
});

test('a token left from a wiped database shows setup without a session-expired message', async () => {
  replies['/api/auth/status'] = { body: { needsSetup: true } };
  replies['/api/auth/user'] = { status: 401, authError: true, body: { error: 'invalid token' } };
  replies['/api/user/onboarding-status'] = { status: 401, authError: true, body: { error: 'invalid token' } };
  render(<AuthProvider><Gate /></AuthProvider>);

  await screen.findByText('setup');
});

test('without a stored token only the setup question is asked', async () => {
  localStorage.clear();
  render(<AuthProvider><Gate /></AuthProvider>);

  await screen.findByText('login');
  assert.deepEqual(startupRequests(), ['/api/auth/status']);
});
