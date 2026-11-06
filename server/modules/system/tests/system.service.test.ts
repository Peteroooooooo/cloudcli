import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createSystemRouter } from '../system.routes.js';
import { createSystemUpdateService } from '../system.service.js';

type SystemUpdateDependencies = Parameters<typeof createSystemUpdateService>[0];

function createDependencies(
  overrides: Partial<SystemUpdateDependencies> = {},
): SystemUpdateDependencies {
  return {
    appRoot: '/app/cloudcli',
    homeDirectory: '/home/cloudcli',
    installMode: 'npm',
    isPlatform: false,
    environment: { TEST_ENVIRONMENT: 'true' },
    runShellCommand: async () => ({ exitCode: 0, output: 'updated', errorOutput: '' }),
    logInfo: () => undefined,
    logError: () => undefined,
    ...overrides,
  };
}

// The old git workflow ran `git checkout main && git pull && npm install` in
// the checkout without rebuilding, which left the running app and the files
// on disk out of step.
test('git installations refuse the in-app update and run nothing', async () => {
  const calls: unknown[][] = [];
  const service = createSystemUpdateService(createDependencies({
    installMode: 'git',
    runShellCommand: async (...args) => {
      calls.push(args);
      return { exitCode: 0, output: '', errorOutput: '' };
    },
  }));

  const result = await service.updateSystem();

  assert.deepEqual(calls, []);
  assert.equal(result.success, false);
  assert.ok('refused' in result && result.refused);
  assert.match('error' in result ? result.error : '', /disabled for git installs/);
});

test('the update endpoint answers 409 for a git installation', async () => {
  const app = express();
  app.use('/api/system', createSystemRouter(createSystemUpdateService(createDependencies({
    installMode: 'git',
    runShellCommand: async () => {
      throw new Error('must not run');
    },
  }))));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address() as AddressInfo;
    const { statusCode, body } = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: '/api/system/update', method: 'POST', agent: false }, (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { data += chunk; });
        response.on('end', () => resolve({ statusCode: response.statusCode, body: data }));
      });
      request.on('error', reject);
      request.end();
    });

    assert.equal(statusCode, 409);
    assert.match((JSON.parse(body) as { error: string }).error, /disabled for git installs/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('global npm installations update from the user home directory', async () => {
  const calls: unknown[][] = [];
  const dependencies = createDependencies({
    installMode: 'npm',
    runShellCommand: async (command, workingDirectory, environment) => {
      calls.push([command, workingDirectory, environment]);
      return { exitCode: 0, output: '', errorOutput: '' };
    },
  });
  const service = createSystemUpdateService(dependencies);

  const result = await service.updateSystem();

  assert.deepEqual(calls, [[
    'npm install -g @cloudcli-ai/cloudcli@latest',
    '/home/cloudcli',
    dependencies.environment,
  ]]);
  assert.equal(result.output, 'Update completed successfully');
});

test('platform installations use the platform workflow regardless of install mode', async () => {
  const calls: unknown[][] = [];
  const dependencies = createDependencies({
    installMode: 'npm',
    isPlatform: true,
    runShellCommand: async (command, workingDirectory, environment) => {
      calls.push([command, workingDirectory, environment]);
      return { exitCode: 0, output: 'platform update complete', errorOutput: '' };
    },
  });
  const service = createSystemUpdateService(dependencies);

  await service.updateSystem();

  assert.deepEqual(calls, [[
    'npm run update:platform',
    '/app/cloudcli',
    dependencies.environment,
  ]]);
});

test('failed update commands retain stdout and stderr for the existing API contract', async () => {
  const service = createSystemUpdateService(createDependencies({
    runShellCommand: async () => ({
      exitCode: 1,
      output: 'installing',
      errorOutput: 'npm failed',
    }),
  }));

  assert.deepEqual(await service.updateSystem(), {
    success: false,
    error: 'Update command failed',
    output: 'installing',
    errorOutput: 'npm failed',
  });
});

test('process startup errors retain their message for the existing API contract', async () => {
  const service = createSystemUpdateService(createDependencies({
    runShellCommand: async () => {
      throw new Error('spawn sh failed');
    },
  }));

  assert.deepEqual(await service.updateSystem(), {
    success: false,
    error: 'spawn sh failed',
  });
});
