import { exec, execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import spawn from 'cross-spawn';

import type { CliApplication, CliPackageMetadata } from '@/shared/types.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

import { createCliService } from './cli.service.js';
import { createSandboxCommandService } from './sandbox.service.js';

const execAsync = promisify(exec);
// The registry check is best effort; without a network it must give up
// instead of hanging around for the default npm retry time.
const LATEST_VERSION_CHECK_TIMEOUT_MS = 10_000;

/**
 * Creates the production CLI application for the executable entrypoint. This is
 * the CLI module's single composition root: it reads package metadata and wires
 * all concrete Node filesystem, subprocess, environment, clock, and module-start
 * adapters before passing them into otherwise isolated services.
 */
export function createCliApplication(): CliApplication {
  const applicationRoot = findApplicationRoot(getModuleDirectory(import.meta.url));
  const packageMetadataJson = JSON.parse(
    fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8'),
  ) as { version: string; homepage?: string; bugs?: { url?: string } };
  const packageMetadata: CliPackageMetadata = {
    version: packageMetadataJson.version,
    homepage: packageMetadataJson.homepage,
    bugsUrl: packageMetadataJson.bugs?.url,
  };
  const fileSystem = {
    pathExists: (filePath: string) => fs.existsSync(filePath),
    getFileStats: (filePath: string) => {
      const stats = fs.statSync(filePath);
      return { size: stats.size, modifiedAt: stats.mtime };
    },
  };
  const output = {
    log: (message?: string) => console.log(message),
    error: (message?: string) => console.error(message),
  };
  const homeDirectory = os.homedir();
  const sandboxService = createSandboxCommandService({
    homeDirectory,
    fileSystem,
    output,
    runSandboxCommand: (argumentsList, inheritOutput = false) => {
      const result = execFileSync('sbx', argumentsList, {
        encoding: 'utf8',
        stdio: inheritOutput ? 'inherit' : 'pipe',
      });
      return result || '';
    },
    spawnDetachedSandbox: (argumentsList) => {
      const childProcess = spawn('sbx', argumentsList, {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      childProcess.unref();
    },
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });

  return createCliService({
    applicationRoot,
    defaultDatabasePath: path.join(homeDirectory, '.cloudcli', 'auth.db'),
    homeDirectory,
    // Same rule the server uses for `/health`.
    installMode: fs.existsSync(path.join(applicationRoot, '.git')) ? 'git' : 'npm',
    packageMetadata,
    environment: process.env,
    fileSystem,
    output,
    sandboxService,
    getLatestPackageVersion: async () => {
      // Asynchronous, so the server keeps starting while npm answers.
      const { stdout } = await execAsync(
        'npm show @cloudcli-ai/cloudcli version',
        { encoding: 'utf8', timeout: LATEST_VERSION_CHECK_TIMEOUT_MS, windowsHide: true },
      );
      return stdout.trim();
    },
    updateGlobalPackage: () => {
      execSync('npm update -g @cloudcli-ai/cloudcli', { stdio: 'inherit' });
    },
    startServer: async () => {
      // The server executable is an entrypoint rather than a feature module,
      // so it has no barrel contract to import through.
      // eslint-disable-next-line boundaries/no-unknown
      await import('../../index.js');
    },
    startBrowserUseMcp: async () => {
      const { startBrowserUseMcp } = await import('../browser-use/index.js');
      await startBrowserUseMcp();
    },
  });
}
