import assert from 'node:assert/strict';
import test from 'node:test';

import type { CliEnvironment, CliOutput } from '@/shared/types.js';

import { createCliService } from '../cli.service.js';

function createHarness(installMode: 'git' | 'npm' = 'npm', latestVersion = '1.2.3') {
  const logMessages: string[] = [];
  const errorMessages: string[] = [];
  const environment: CliEnvironment = {};
  const output: CliOutput = {
    log: (message = '') => logMessages.push(message),
    error: (message = '') => errorMessages.push(message),
  };
  let serverStarts = 0;
  let latestVersionChecks = 0;
  let globalUpdates = 0;
  let sandboxArguments: string[] = [];
  const service = createCliService({
    applicationRoot: '/application',
    defaultDatabasePath: '/home/user/.cloudcli/auth.db',
    homeDirectory: '/home/user',
    installMode,
    packageMetadata: {
      version: '1.2.3',
      homepage: 'https://cloudcli.example',
      bugsUrl: 'https://cloudcli.example/issues',
    },
    environment,
    fileSystem: {
      pathExists: () => false,
      getFileStats: () => ({ size: 0, modifiedAt: new Date(0) }),
    },
    output,
    sandboxService: {
      execute: async (argumentsList) => {
        sandboxArguments = argumentsList;
        return 7;
      },
    },
    getLatestPackageVersion: async () => {
      latestVersionChecks += 1;
      return latestVersion;
    },
    updateGlobalPackage: () => {
      globalUpdates += 1;
    },
    startServer: async () => {
      serverStarts += 1;
    },
    startBrowserUseMcp: async () => undefined,
  });

  return {
    service,
    environment,
    logMessages,
    errorMessages,
    getServerStarts: () => serverStarts,
    getLatestVersionChecks: () => latestVersionChecks,
    getGlobalUpdates: () => globalUpdates,
    getSandboxArguments: () => sandboxArguments,
  };
}

// A git checkout of this fork is not the npm package: asking the registry
// only delayed startup (minutes before the network is up) for a meaningless answer.
test('a git checkout starts without asking npm for the latest version', async () => {
  const harness = createHarness('git', '9.9.9');

  assert.equal(await harness.service.run([]), 0);
  assert.equal(harness.getServerStarts(), 1);
  assert.equal(harness.getLatestVersionChecks(), 0);

  assert.equal(await harness.service.run(['update']), 0);
  assert.equal(harness.getLatestVersionChecks(), 0);
  assert.equal(harness.getGlobalUpdates(), 0);
  assert.match(harness.logMessages.at(-1) ?? '', /git checkout/);
});

test('an npm install still checks for and installs a newer version', async () => {
  const harness = createHarness('npm', '9.9.9');

  await harness.service.run([]);
  assert.equal(harness.getLatestVersionChecks(), 1);

  await harness.service.run(['update']);
  assert.equal(harness.getGlobalUpdates(), 1);
});

test('applies CLI options to the injected environment before starting the server', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run([
    '--port',
    '8080',
    '--database-path=/data/app.db',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(harness.environment.SERVER_PORT, '8080');
  assert.equal(harness.environment.DATABASE_PATH, '/data/app.db');
  assert.equal(harness.getServerStarts(), 1);
});

test('passes only sandbox arguments to the injected sandbox service', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run(['sandbox', 'ls']);

  assert.equal(exitCode, 7);
  assert.deepEqual(harness.getSandboxArguments(), ['ls']);
});

test('returns a failure code for an unknown command without exiting the process', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run(['unknown']);

  assert.equal(exitCode, 1);
  assert.match(harness.errorMessages[0], /Unknown command: unknown/);
});
