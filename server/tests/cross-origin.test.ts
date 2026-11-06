import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Boots the real server/index.ts in a child process and checks that another
 * site cannot read its responses. The child gets its own home directory,
 * database and port, so it never touches the user's data or a running server.
 */

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.resolve(testDirectory, '..', '..');
const FOREIGN_ORIGIN = 'https://evil.example';
const STARTUP_TIMEOUT_MS = 60_000;

type HeadersResponse = { statusCode?: number; headers: http.IncomingHttpHeaders };

async function findFreePort(): Promise<number> {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function request(port: number, method: string, requestPath: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<HeadersResponse>((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers, agent: false }, (response) => {
      response.resume();
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function waitForHealth(port: number, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited with code ${child.exitCode}:\n${output()}`);
    }
    try {
      const { statusCode } = await request(port, 'GET', '/health');
      if (statusCode === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not answer /health within ${STARTUP_TIMEOUT_MS} ms:\n${output()}`);
}

test('another origin gets no Access-Control-Allow-Origin header', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-cross-origin-'));
  const home = path.join(fixtureRoot, 'home');
  const temp = path.join(fixtureRoot, 'tmp');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(temp, { recursive: true })]);
  const port = await findFreePort();

  // Built from scratch so CLAUDE_CONFIG_DIR, CODEX_HOME and similar settings
  // of the shell running the tests cannot point the child at real data.
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    DATABASE_PATH: path.join(fixtureRoot, 'auth.db'),
    HOST: '127.0.0.1',
    SERVER_PORT: String(port),
    TSX_TSCONFIG_PATH: path.join(applicationRoot, 'server', 'tsconfig.json'),
  };

  // `--import tsx` keeps the server in this one process, so killing it leaves
  // nothing behind holding the port.
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(applicationRoot, 'server', 'index.ts')], {
    cwd: applicationRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });

  try {
    await waitForHealth(port, child, () => output);

    const preflight = await request(port, 'OPTIONS', '/api/auth/status', {
      Origin: FOREIGN_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    });
    assert.equal(preflight.headers['access-control-allow-origin'], undefined);
    assert.equal(preflight.headers['access-control-allow-headers'], undefined);

    const read = await request(port, 'GET', '/health', { Origin: FOREIGN_ORIGIN });
    assert.equal(read.statusCode, 200);
    assert.equal(read.headers['access-control-allow-origin'], undefined);
    assert.equal(read.headers['access-control-expose-headers'], undefined);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
