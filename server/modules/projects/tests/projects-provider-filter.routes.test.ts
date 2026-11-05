import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import projectsRouter from '@/modules/projects/projects.routes.js';
import { AppError } from '@/shared/utils.js';

/**
 * The sidebar's agent filter is applied on the server: `?provider=` narrows
 * each project's session page and the total next to it, absent or `all` lists
 * every provider, and anything else is refused before any work is done.
 */

type ProjectsResponse = Array<{
  projectId: string;
  path: string;
  sessions: Array<{ id: string; provider: string }>;
  sessionMeta: { hasMore: boolean; total: number };
}>;

async function withProjectsServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'projects-provider-filter-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/projects', projectsRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Two projects: a mixed one (3 Claude, 2 Codex, one archived Codex) and a Claude-only one. */
function seedSessions() {
  const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
  sessionsDb.createSession('mixed-claude-1', 'claude', '/workspace/mixed', 'Claude 1', at(1), at(1));
  sessionsDb.createSession('mixed-codex-1', 'codex', '/workspace/mixed', 'Codex 1', at(2), at(2));
  sessionsDb.createSession('mixed-claude-2', 'claude', '/workspace/mixed', 'Claude 2', at(3), at(3));
  sessionsDb.createSession('mixed-codex-2', 'codex', '/workspace/mixed', 'Codex 2', at(4), at(4));
  sessionsDb.createSession('mixed-claude-3', 'claude', '/workspace/mixed', 'Claude 3', at(5), at(5));
  sessionsDb.createSession('mixed-codex-archived', 'codex', '/workspace/mixed', 'Archived', at(6), at(6));
  sessionsDb.updateSessionIsArchived('mixed-codex-archived', true);
  sessionsDb.createSession('claude-only-1', 'claude', '/workspace/claude-only', 'Only Claude', at(7), at(7));
}

// Matched by folder name: the stored path is normalized for the platform.
const byPath = (projects: ProjectsResponse, projectPath: string) => {
  const project = projects.find((candidate) => path.basename(candidate.path) === path.posix.basename(projectPath));
  assert.ok(project, `project ${projectPath} is listed`);
  return project;
};

test('GET /api/projects narrows every project page and total to the requested provider', async () => {
  await withProjectsServer(async (baseUrl) => {
    seedSessions();

    const response = await fetch(`${baseUrl}/api/projects?skipSync=1&provider=codex`);
    const projects = await response.json() as ProjectsResponse;

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(projects), 'the response stays a bare array');
    // Projects are still listed when they have no session of that provider;
    // hiding them is the sidebar's call.
    assert.equal(projects.length, 2);

    const mixed = byPath(projects, '/workspace/mixed');
    assert.deepEqual(mixed.sessions.map((session) => session.id), ['mixed-codex-2', 'mixed-codex-1']);
    assert.ok(mixed.sessions.every((session) => session.provider === 'codex'));
    assert.deepEqual(mixed.sessionMeta, { hasMore: false, total: 2 });

    const claudeOnly = byPath(projects, '/workspace/claude-only');
    assert.deepEqual(claudeOnly.sessions, []);
    assert.deepEqual(claudeOnly.sessionMeta, { hasMore: false, total: 0 });
  });
});

test('GET /api/projects pages within the provider when sessionsLimit is set', async () => {
  await withProjectsServer(async (baseUrl) => {
    seedSessions();

    const response = await fetch(`${baseUrl}/api/projects?skipSync=1&provider=claude&sessionsLimit=2`);
    const mixed = byPath(await response.json() as ProjectsResponse, '/workspace/mixed');

    assert.deepEqual(mixed.sessions.map((session) => session.id), ['mixed-claude-3', 'mixed-claude-2']);
    assert.deepEqual(mixed.sessionMeta, { hasMore: true, total: 3 });
  });
});

test('GET /api/projects lists every provider when the filter is absent or "all"', async () => {
  await withProjectsServer(async (baseUrl) => {
    seedSessions();

    for (const suffix of ['', '&provider=all', '&provider=ALL', '&provider=']) {
      const response = await fetch(`${baseUrl}/api/projects?skipSync=1${suffix}`);
      const mixed = byPath(await response.json() as ProjectsResponse, '/workspace/mixed');
      assert.equal(response.status, 200, suffix);
      assert.equal(mixed.sessionMeta.total, 5, suffix);
      assert.equal(mixed.sessions.length, 5, suffix);
    }
  });
});

test('GET /api/projects refuses an unknown provider with 400', async () => {
  await withProjectsServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects?skipSync=1&provider=gemini`);
    const payload = await response.json() as { error: { code: string } };

    assert.equal(response.status, 400);
    assert.equal(payload.error.code, 'INVALID_PROVIDER_FILTER');
  });
});

test('GET /api/projects/:projectId/sessions pages within the provider', async () => {
  await withProjectsServer(async (baseUrl) => {
    seedSessions();
    const listResponse = await fetch(`${baseUrl}/api/projects?skipSync=1`);
    const { projectId } = byPath(await listResponse.json() as ProjectsResponse, '/workspace/mixed');

    const sessionsUrl = (query: string) => `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/sessions?${query}`;
    type SessionsPage = { sessions: Array<{ id: string }>; sessionMeta: { hasMore: boolean; total: number } };

    const second = await fetch(sessionsUrl('provider=claude&limit=2&offset=2'));
    const secondPage = await second.json() as SessionsPage;
    assert.equal(second.status, 200);
    assert.deepEqual(secondPage.sessions.map((session) => session.id), ['mixed-claude-1']);
    assert.deepEqual(secondPage.sessionMeta, { hasMore: false, total: 3 });

    const codex = await fetch(sessionsUrl('provider=codex&limit=1&offset=0'));
    const codexPage = await codex.json() as SessionsPage;
    assert.deepEqual(codexPage.sessions.map((session) => session.id), ['mixed-codex-2']);
    assert.deepEqual(codexPage.sessionMeta, { hasMore: true, total: 2 });

    const unfiltered = await fetch(sessionsUrl('limit=20&offset=0'));
    assert.equal((await unfiltered.json() as SessionsPage).sessionMeta.total, 5);

    const invalid = await fetch(sessionsUrl('provider=nope'));
    assert.equal(invalid.status, 400);
  });
});
