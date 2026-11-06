import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import express from 'express';

import { createGitRouter } from '@/modules/git/git.routes.js';

/**
 * The file-path guard compared `path.resolve(root) + path.sep` with a
 * case-sensitive prefix check, so a repository at a drive root (`D:\`) built
 * the prefix `D:\\` and refused every file in it, and on Windows a `d:\` path
 * was refused for a `D:\` root.
 */

const filesystemRoot = path.parse(process.cwd()).root;

async function requestBranchDiffFile(file: string, repositoryRoot = filesystemRoot) {
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true\n');
      else if (args.includes('--show-toplevel')) child.stdout.write(`${repositoryRoot}\n`);
      else if (args[0] === 'diff') child.stdout.write('@@ -1 +1 @@\n-old\n+new\n');
      else if (args[0] !== 'ls-files') child.stdout.write('abc123\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => path.join(filesystemRoot, 'repo-project'),
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const query = new URLSearchParams({ project: 'project-1', base: 'main', file });
    const text = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: address.port, path: `/api/git/branch-diff/file?${query}`, agent: false }, (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { data += chunk; });
        response.on('end', () => resolve(data));
      }).on('error', reject);
    });
    return { body: JSON.parse(text) as { diff?: string; error?: string; details?: string }, commands };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a file in a repository at the drive root is accepted', async () => {
  const { body, commands } = await requestBranchDiffFile('src/a.ts');

  assert.equal(body.error, undefined, body.details);
  assert.match(body.diff ?? '', /\+new/);
  assert.ok(commands.some((args) => args[0] === 'diff' && args.at(-1) === 'src/a.ts'));
});

test('a path that leaves the repository is still refused before git diff runs', async () => {
  const { body, commands } = await requestBranchDiffFile('../outside.txt', path.join(filesystemRoot, 'repo'));

  assert.match(body.details ?? '', /path traversal detected/);
  assert.equal(commands.some((args) => args[0] === 'diff'), false);
});

test('the drive letter case does not matter on Windows', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('drive letters only exist on Windows');
    return;
  }
  const repositoryRoot = path.join(filesystemRoot.toUpperCase(), 'repo');
  const lowerCaseDriveFile = `${repositoryRoot[0].toLowerCase()}${repositoryRoot.slice(1)}/src/a.ts`;

  const { body } = await requestBranchDiffFile(lowerCaseDriveFile, repositoryRoot);
  assert.equal(body.error, undefined, body.details);

  const otherDrive = repositoryRoot[0] === 'Z' ? 'Y' : 'Z';
  const refused = await requestBranchDiffFile(`${otherDrive}${repositoryRoot.slice(1)}/src/a.ts`, repositoryRoot);
  assert.match(refused.body.details ?? '', /path traversal detected/);
});
