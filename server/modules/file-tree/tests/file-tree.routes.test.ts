import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import type { FileTreeServices } from '@/shared/types.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFile: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectFiles: unexpectedOperation,
    listDirectory: unexpectedOperation,
    searchProjectFiles: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
  ));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('project files route uses the File Tree API namespace and forwards the project id', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: false }]]);
});

test('project files route requests gitignore filtering when explicitly enabled', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true }]]);
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});

test('children route parses the folder, page and gitignore flag', async () => {
  const inputs: Parameters<FileTreeServices['listDirectory']>[] = [];
  const services = createFakeServices({
    listDirectory: async (...input) => {
      inputs.push(input);
      return { path: '/workspace/project', entries: [], total: 0, offset: 0, hasMore: false, truncated: false };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const rootResponse = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/children`);
    assert.equal(rootResponse.status, 200);

    const folderResponse = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files/children?path=${encodeURIComponent('/workspace/project/src')}&offset=500&limit=200&respectGitignore=true`,
    );
    assert.equal(folderResponse.status, 200);
  });

  assert.deepEqual(inputs, [
    ['project-1', { directoryPath: null, offset: 0, limit: 500, respectGitignore: false }],
    ['project-1', { directoryPath: '/workspace/project/src', offset: 500, limit: 200, respectGitignore: true }],
  ]);
});

test('children route rejects an out-of-range page without calling the service', async () => {
  let listCalled = false;
  const services = createFakeServices({
    listDirectory: async () => {
      listCalled = true;
      throw new Error('listDirectory should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    for (const badQuery of ['limit=0', 'limit=5000', 'offset=-1', 'limit=abc']) {
      const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/children?${badQuery}`);
      assert.equal(response.status, 400, badQuery);
    }
  });

  assert.equal(listCalled, false);
});

test('search route parses the query and its bounds', async () => {
  const inputs: Array<Omit<Parameters<FileTreeServices['searchProjectFiles']>[1], 'signal'>> = [];
  const services = createFakeServices({
    searchProjectFiles: async (_projectId, { signal, ...input }) => {
      assert.ok(signal instanceof AbortSignal);
      inputs.push(input);
      return { results: [], truncated: false };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const defaultsResponse = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/search?q=logo`);
    assert.equal(defaultsResponse.status, 200);
    assert.deepEqual(await defaultsResponse.json(), { results: [], truncated: false });

    const explicitResponse = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files/search?q=Logo-128&match=name&filesOnly=true&limit=10&respectGitignore=true`,
    );
    assert.equal(explicitResponse.status, 200);

    const badMatch = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/search?q=a&match=regex`);
    assert.equal(badMatch.status, 400);
    const badLimit = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/search?q=a&limit=100000`);
    assert.equal(badLimit.status, 400);
  });

  assert.deepEqual(inputs, [
    { query: 'logo', match: 'path', filesOnly: false, limit: 100, respectGitignore: false },
    { query: 'Logo-128', match: 'name', filesOnly: true, limit: 10, respectGitignore: true },
  ]);
});

test('search route aborts the walk when the client goes away', async () => {
  let observedSignal: AbortSignal | undefined;
  const services = createFakeServices({
    searchProjectFiles: async (_projectId, input) => {
      observedSignal = input.signal;
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const clientAbort = new AbortController();
    const pending = fetch(`${baseUrl}/api/file-tree/projects/project-1/files/search?q=a`, {
      signal: clientAbort.signal,
    }).catch(() => undefined);
    while (!observedSignal) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    clientAbort.abort();
    await pending;
    for (let attempt = 0; attempt < 100 && !observedSignal.aborted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  assert.equal(observedSignal?.aborted, true);
});
