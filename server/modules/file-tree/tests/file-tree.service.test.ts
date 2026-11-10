import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeStats,
} from '@/shared/types.js';
import { AppError, resolveReadOnlyRootPath, validateWorkspacePath } from '@/shared/utils.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    ...overrides,
  };
}

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async () => null,
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  };
}

test('listProjectFiles applies gitignore alongside hard directory exclusions', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const gitDirectory = path.join(projectRoot, '.git');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return '*.log';
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.git', true),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('README.md', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [createDirectoryEntry('build', true)];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('foo.md', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [createDirectoryEntry('index.ts', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === documentationDirectory
        || candidatePath === buildDocumentationDirectory
        || candidatePath === sourceDirectory
        || candidatePath === gitDirectory
        || candidatePath === nodeModulesDirectory,
      0o754,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'src', 'README.md']);
  const documentationEntry = tree[0];
  assert.deepEqual(documentationEntry?.children?.map((entry) => entry.name), ['build']);
  assert.deepEqual(documentationEntry?.children?.[0]?.children?.map((entry) => entry.name), ['foo.md']);
  const sourceEntry = tree[1];
  assert.ok(sourceEntry);
  assert.equal(sourceEntry.type, 'directory');
  assert.equal(sourceEntry.permissions, '754');
  assert.equal(sourceEntry.permissionsRwx, 'rwxr-xr--');
  assert.deepEqual(sourceEntry.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(gitDirectory), false);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
});

test('listProjectFiles excludes gitignored entries only when requested', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const cacheDirectory = path.join(projectRoot, 'cache');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return ['*.log', '!keep.log', 'cache/', 'src/generated.ts'].join('\n');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.gitignore', false),
          createDirectoryEntry('cache', true),
          createDirectoryEntry('ignored.log', false),
          createDirectoryEntry('keep.log', false),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === cacheDirectory) {
        return [createDirectoryEntry('cached.txt', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [
          createDirectoryEntry('generated.ts', false),
          createDirectoryEntry('index.ts', false),
        ];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === cacheDirectory || candidatePath === sourceDirectory,
      0o644,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['src', '.gitignore', 'keep.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(cacheDirectory), false);
});

test('listProjectFiles falls back to conventional directory names when no gitignore exists', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('debug.log', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('node_modules', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [
          createDirectoryEntry('build', true),
          createDirectoryEntry('guide.md', false),
        ];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('generated.md', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(candidatePath === documentationDirectory, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'debug.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['guide.md']);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
  assert.equal(readDirectories.includes(buildDocumentationDirectory), false);
});

test('listProjectFiles rejects a tree that exceeds the server entry limit', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? Array.from({ length: 10_001 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false))
      : []),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('listProjectFiles abandons a directory stream as soon as the entry limit is passed', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Endless on purpose: the walk has to stop consuming the stream itself
    // instead of waiting for the directory listing to be materialized.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; ; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
  // The budget plus the single entry that proves it was exceeded.
  assert.equal(streamedEntries, 10_001);
});

test('listProjectFiles shares the entry limit across nested directories', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const firstDirectory = path.join(projectRoot, 'first');
  const secondDirectory = path.join(projectRoot, 'second');
  const directoryPaths = new Set([firstDirectory, secondDirectory]);
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('first', true),
          createDirectoryEntry('second', true),
        ];
      }
      if (directoryPaths.has(directoryPath)) {
        return Array.from(
          { length: 5_000 },
          (_, index) => createDirectoryEntry(`${path.basename(directoryPath)}-${index}.txt`, false),
        );
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(directoryPaths.has(candidatePath), 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('readTextFile rejects traversal before invoking the filesystem adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'should not be read';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', '../secret.txt'),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_PROJECT'
      && error.statusCode === 403,
  );
  assert.deepEqual(readPaths, []);
});

test('readTextFile reports a directory as a client error, not a 500', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    stat: async () => createStats(true, 0o755),
    readTextFile: async () => {
      throw new Error('a directory must not be read');
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'decisions'),
    (error: unknown) => error instanceof AppError
      && error.code === 'EISDIR'
      && error.statusCode === 400
      && error.message === 'Path is a directory, not a file',
  );
});

test('readTextFile refuses a file over 5 MB without reading it', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const statsOfSize = (size: number): FileTreeStats => ({ ...createStats(false, 0o644), size });
  let fileSize = 12.5 * 1024 * 1024;
  const fileSystem = createFakeFileSystem({
    stat: async () => statsOfSize(fileSize),
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'small enough';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'huge.log'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TOO_LARGE'
      && error.statusCode === 413
      && error.message === 'File is too large to open in the editor (12.5 MB; the limit is 5 MB).',
  );
  fileSize = 5 * 1024 * 1024 + 1;
  await assert.rejects(
    service.readTextFile('project-1', 'huge.log'),
    (error: unknown) => error instanceof AppError && error.code === 'FILE_TOO_LARGE',
  );
  assert.deepEqual(readPaths, []);

  fileSize = 5 * 1024 * 1024;
  assert.equal((await service.readTextFile('project-1', 'huge.log')).content, 'small enough');
});

test('readTextFile maps a missing file to 404 at the size check', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    stat: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'gone.txt'),
    (error: unknown) => error instanceof AppError && error.statusCode === 404 && error.message === 'File not found',
  );
});

test('createEntry performs filesystem mutation only through the injected adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const targetPath = path.join(projectRoot, 'notes.txt');
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (candidatePath === targetPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    writeTextFile: async (filePath, content) => {
      writtenFiles.push({ filePath, content });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'notes.txt',
  });

  assert.equal(result.path, targetPath);
  assert.deepEqual(writtenFiles, [{ filePath: targetPath, content: '' }]);
});

function createRecordingWriteService(projectRoot: string) {
  const writtenPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    writeTextFile: async (filePath) => {
      writtenPaths.push(filePath);
    },
  });
  return { service: createFileTreeService(createDependencies(fileSystem, projectRoot)), writtenPaths };
}

const isOutsideProjectError = (error: unknown) => error instanceof AppError
  && error.code === 'PATH_OUTSIDE_PROJECT'
  && error.statusCode === 403;

test('a project at a drive or filesystem root accepts the files under it', async () => {
  const filesystemRoot = path.parse(process.cwd()).root;
  const { service, writtenPaths } = createRecordingWriteService(filesystemRoot);

  await service.saveTextFile('project-1', path.join(filesystemRoot, 'notes.txt'), 'x');
  await service.saveTextFile('project-1', path.join('docs', 'guide.md'), 'x');

  assert.deepEqual(writtenPaths, [
    path.join(filesystemRoot, 'notes.txt'),
    path.join(filesystemRoot, 'docs', 'guide.md'),
  ]);
  await assert.rejects(service.saveTextFile('project-1', filesystemRoot, 'x'), isOutsideProjectError);
});

test('the drive letter case does not matter on Windows, and traversal is still refused', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('drive letters only exist on Windows');
    return;
  }
  // Project roots are stored as `D:\…`; VS Code transcripts quote `d:\…`.
  const projectRoot = path.resolve('file-tree-test-project');
  const lowerCaseDrivePath = path.join(projectRoot[0].toLowerCase() + projectRoot.slice(1), 'src', 'a.ts');
  const { service, writtenPaths } = createRecordingWriteService(projectRoot);

  await service.saveTextFile('project-1', lowerCaseDrivePath, 'x');
  assert.deepEqual(writtenPaths, [lowerCaseDrivePath]);

  const otherDrive = projectRoot[0].toUpperCase() === 'Z' ? 'Y:\\' : 'Z:\\';
  for (const outsidePath of [
    path.join('..', 'secret.txt'),
    path.join(projectRoot, '..', 'secret.txt'),
    `${projectRoot}-sibling\\secret.txt`,
    path.join(otherDrive, path.relative(path.parse(projectRoot).root, projectRoot), 'a.ts'),
  ]) {
    await assert.rejects(service.saveTextFile('project-1', outsidePath, 'x'), isOutsideProjectError, outsidePath);
  }
  assert.equal(writtenPaths.length, 1);
});

/**
 * Builds the service against the real filesystem and the real workspace policy,
 * which is the only way to exercise the read-only roots: the whole guarantee
 * rests on `realpath` resolving symlinks before the comparison.
 */
function createRealFileSystemService(projectRoot: string, workspaceRoot = projectRoot): FileTreeServices {
  return createFileTreeService({
    fileSystem: {
      access: (candidatePath) => fsPromises.access(candidatePath),
      stat: (candidatePath) => fsPromises.stat(candidatePath),
      lstat: (candidatePath) => fsPromises.lstat(candidatePath),
      openDirectory: async function* (directoryPath) {
        yield* await fsPromises.opendir(directoryPath);
      },
      realpath: (candidatePath) => fsPromises.realpath(candidatePath),
      readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
      writeTextFile: (filePath, content) => fsPromises.writeFile(filePath, content, 'utf8'),
      async makeDirectory(directoryPath, recursive) {
        await fsPromises.mkdir(directoryPath, { recursive });
      },
      rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
      async removeDirectory(directoryPath) {
        await fsPromises.rm(directoryPath, { recursive: true, force: true });
      },
      unlink: (filePath) => fsPromises.unlink(filePath),
      copyFile: (source, destination) => fsPromises.copyFile(source, destination),
      createReadStream: (filePath) => createReadStream(filePath),
    },
    projects: { getProjectPathById: async () => projectRoot },
    workspace: {
      rootPath: workspaceRoot,
      validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
      resolveReadOnlyRootPath: (candidatePath) => resolveReadOnlyRootPath(candidatePath),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  });
}

test('the temp directory can be browsed and read, but never written to', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));

  try {
    // The shape a task notification quotes: an agent's output file written to
    // the system temp directory, outside every project.
    await fsPromises.mkdir(path.join(temporaryDirectory, 'tasks'));
    const outputPath = path.join(temporaryDirectory, 'tasks', 'agent.output');
    await fsPromises.writeFile(outputPath, 'what the agent found', 'utf8');

    const service = createRealFileSystemService(projectRoot);

    const browsed = await service.browseWorkspace(temporaryDirectory);
    assert.deepEqual(browsed.suggestions.map((entry) => entry.name), ['tasks']);

    const opened = await service.readTextFile('project-1', outputPath);
    assert.equal(opened.content, 'what the agent found');

    const streamed = await service.openFile('project-1', outputPath);
    streamed.stream.destroy();

    // Read-only means read-only: nothing may be created or changed there.
    await assert.rejects(
      service.saveTextFile('project-1', outputPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.createWorkspaceFolder(path.join(temporaryDirectory, 'new-folder')),
      (error: unknown) => (error as AppError).code === 'INVALID_WORKSPACE_PATH',
    );
    await assert.rejects(
      service.createEntry({
        projectId: 'project-1',
        parentPath: path.join(temporaryDirectory, 'tasks'),
        type: 'file',
        name: 'planted.txt',
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: outputPath, newName: 'renamed.output' }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    const uploadedTemporaryPath = path.join(projectRoot, 'upload.tmp');
    await fsPromises.writeFile(uploadedTemporaryPath, 'upload', 'utf8');
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: path.join(temporaryDirectory, 'tasks'),
        relativePaths: [],
        requestedFileCount: 1,
        files: [{ originalName: 'upload.txt', temporaryPath: uploadedTemporaryPath, size: 6, mimeType: 'text/plain' }],
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: outputPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.deepEqual(await fsPromises.readdir(path.join(temporaryDirectory, 'tasks')), ['agent.output']);
    assert.equal(await fsPromises.readFile(outputPath, 'utf8'), 'what the agent found');
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('reading through a symlink out of the temp directory is still refused', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  // The link target has to sit under no read-only root. Beside this file is
  // deterministic; a directory under `$HOME` lands under `/tmp` whenever a
  // test run isolates its home there, and the Claude projects directory is a
  // read-only root too.
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    assert.equal(await resolveReadOnlyRootPath(outsideDirectory), null);
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(temporaryDirectory, 'escape'));

    const service = createRealFileSystemService(projectRoot);
    await assert.rejects(
      service.readTextFile('project-1', path.join(temporaryDirectory, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('a file in another folder of the workspace can be read, but never written to', async () => {
  // Both sit beside this file, outside every read-only root, for the reason
  // given in the symlink test above.
  const workspaceRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-workspace-'));
  const projectRoot = path.join(workspaceRoot, 'project');
  const siblingDirectory = path.join(workspaceRoot, '.runs', 'run-1');
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    await fsPromises.mkdir(projectRoot);
    await fsPromises.mkdir(siblingDirectory, { recursive: true });
    const reportPath = path.join(siblingDirectory, 'report.md');
    await fsPromises.writeFile(reportPath, 'what the run found', 'utf8');
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(workspaceRoot, 'escape'));

    const service = createRealFileSystemService(projectRoot, workspaceRoot);

    const opened = await service.readTextFile('project-1', reportPath);
    assert.equal(opened.content, 'what the run found');
    const streamed = await service.openFile('project-1', reportPath);
    streamed.stream.destroy();

    await assert.rejects(
      service.saveTextFile('project-1', reportPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: reportPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.equal(await fsPromises.readFile(reportPath, 'utf8'), 'what the run found');

    // A link inside the workspace does not open what lies outside it.
    await assert.rejects(
      service.readTextFile('project-1', path.join(workspaceRoot, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

/**
 * A small fake project for the on-demand listing and the search. Every folder
 * is described by its children, which the fake directory reader returns in a
 * deliberately unsorted order.
 */
function createFakeProjectFileSystem(
  projectRoot: string,
  layout: Record<string, Array<[name: string, directory: boolean]>>,
  overrides: Partial<FileTreeFileSystem> = {},
) {
  const readDirectories: string[] = [];
  const directoryPaths = new Set(Object.keys(layout).map((relative) => path.join(projectRoot, relative)));
  directoryPaths.add(projectRoot);
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    realpath: async (candidatePath) => candidatePath,
    stat: async (candidatePath) => createStats(directoryPaths.has(candidatePath), 0o755),
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      const relative = path.relative(projectRoot, directoryPath);
      return (layout[relative] ?? []).map(([name, directory]) => createDirectoryEntry(name, directory));
    }),
    lstat: async (candidatePath) => createStats(directoryPaths.has(candidatePath), 0o644),
    ...overrides,
  });
  return { fileSystem, readDirectories };
}

const sampleLayout: Record<string, Array<[string, boolean]>> = {
  '': [['README.md', false], ['src', true], ['node_modules', true], ['assets', true], ['build', true]],
  src: [['main.ts', false], ['lib', true], ['logo-helper.ts', false]],
  [path.join('src', 'lib')]: [['logo.ts', false]],
  assets: [['logo-128.png', false], ['banner.png', false]],
  build: [['logo-built.png', false]],
};

test('listDirectory returns one folder level, sorted, without reading deeper', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const { fileSystem, readDirectories } = createFakeProjectFileSystem(projectRoot, sampleLayout);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const rootListing = await service.listDirectory('project-1', {
    directoryPath: null, offset: 0, limit: 500, respectGitignore: true,
  });

  // Hard exclusions and the fallback names apply, folders come first.
  assert.deepEqual(rootListing.entries.map((entry) => entry.name), ['assets', 'src', 'README.md']);
  assert.equal(rootListing.path, projectRoot);
  assert.equal(rootListing.total, 3);
  assert.equal(rootListing.hasMore, false);
  assert.equal(rootListing.entries[0]?.children, undefined);
  assert.equal(rootListing.entries[2]?.permissions, '644');
  assert.deepEqual(readDirectories, [projectRoot]);

  const sourceListing = await service.listDirectory('project-1', {
    directoryPath: path.join(projectRoot, 'src'), offset: 0, limit: 500, respectGitignore: true,
  });
  assert.deepEqual(sourceListing.entries.map((entry) => entry.path), [
    path.join(projectRoot, 'src', 'lib'),
    path.join(projectRoot, 'src', 'logo-helper.ts'),
    path.join(projectRoot, 'src', 'main.ts'),
  ]);

  // A project-relative folder and the root spelled out both work too.
  const relativeListing = await service.listDirectory('project-1', {
    directoryPath: 'src', offset: 0, limit: 500, respectGitignore: true,
  });
  assert.equal(relativeListing.path, path.join(projectRoot, 'src'));
  const explicitRoot = await service.listDirectory('project-1', {
    directoryPath: projectRoot, offset: 0, limit: 500, respectGitignore: true,
  });
  assert.equal(explicitRoot.total, 3);
});

test('listDirectory pages a huge folder and only reads metadata for the page', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const lstatPaths: string[] = [];
  const { fileSystem } = createFakeProjectFileSystem(projectRoot, {
    '': Array.from({ length: 12_000 }, (_, index): [string, boolean] => [`file-${String(index).padStart(5, '0')}.txt`, false]),
  }, {
    lstat: async (candidatePath) => {
      lstatPaths.push(candidatePath);
      return createStats(false, 0o644);
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const firstPage = await service.listDirectory('project-1', {
    directoryPath: null, offset: 0, limit: 500, respectGitignore: false,
  });
  assert.equal(firstPage.entries.length, 500);
  assert.equal(firstPage.total, 12_000);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.truncated, false);
  assert.equal(firstPage.entries[0]?.name, 'file-00000.txt');
  assert.equal(lstatPaths.length, 500);

  const lastPage = await service.listDirectory('project-1', {
    directoryPath: null, offset: 11_500, limit: 2_000, respectGitignore: false,
  });
  assert.equal(lastPage.entries.length, 500);
  assert.equal(lastPage.entries.at(-1)?.name, 'file-11999.txt');
  assert.equal(lastPage.hasMore, false);
});

test('listDirectory refuses folders outside the project before reading them', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const { fileSystem, readDirectories } = createFakeProjectFileSystem(projectRoot, sampleLayout);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  for (const outsidePath of [path.join('..', 'other'), path.join(projectRoot, '..'), `${projectRoot}-sibling`]) {
    await assert.rejects(
      service.listDirectory('project-1', { directoryPath: outsidePath, offset: 0, limit: 500, respectGitignore: false }),
      isOutsideProjectError,
      outsidePath,
    );
  }
  assert.deepEqual(readDirectories, []);
});

test('listDirectory refuses a folder whose real path leaves the project', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const linkPath = path.join(projectRoot, 'escape');
  const { fileSystem, readDirectories } = createFakeProjectFileSystem(projectRoot, sampleLayout, {
    realpath: async (candidatePath) => candidatePath === linkPath ? path.resolve('outside-the-project') : candidatePath,
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listDirectory('project-1', { directoryPath: linkPath, offset: 0, limit: 500, respectGitignore: false }),
    isOutsideProjectError,
  );
  assert.deepEqual(readDirectories, []);
});

test('listDirectory reports a file as a client error', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const { fileSystem } = createFakeProjectFileSystem(projectRoot, sampleLayout);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listDirectory('project-1', {
      directoryPath: path.join(projectRoot, 'README.md'), offset: 0, limit: 500, respectGitignore: false,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'NOT_A_DIRECTORY' && error.statusCode === 400,
  );
});

test('a project at a drive or filesystem root lists its root and its folders', async () => {
  const filesystemRoot = path.parse(process.cwd()).root;
  const { fileSystem } = createFakeProjectFileSystem(filesystemRoot, { '': [['docs', true]], docs: [['a.md', false]] });
  const service = createFileTreeService(createDependencies(fileSystem, filesystemRoot));

  const rootListing = await service.listDirectory('project-1', {
    directoryPath: null, offset: 0, limit: 500, respectGitignore: false,
  });
  assert.deepEqual(rootListing.entries.map((entry) => entry.path), [path.join(filesystemRoot, 'docs')]);
  const docsListing = await service.listDirectory('project-1', {
    directoryPath: path.join(filesystemRoot, 'docs'), offset: 0, limit: 500, respectGitignore: false,
  });
  assert.deepEqual(docsListing.entries.map((entry) => entry.name), ['a.md']);
});

test('listDirectory accepts a lower-case drive letter on Windows', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('drive letters only exist on Windows');
    return;
  }
  const projectRoot = path.resolve('file-tree-test-project');
  const lowerCaseSource = path.join(projectRoot[0].toLowerCase() + projectRoot.slice(1), 'src');
  const { fileSystem } = createFakeProjectFileSystem(projectRoot, sampleLayout, {
    stat: async () => createStats(true, 0o755),
    openDirectory: createDirectoryReader((directoryPath) => directoryPath.toLowerCase() === lowerCaseSource.toLowerCase()
      ? [createDirectoryEntry('main.ts', false)]
      : []),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const listing = await service.listDirectory('project-1', {
    directoryPath: lowerCaseSource, offset: 0, limit: 500, respectGitignore: false,
  });
  assert.equal(listing.path, lowerCaseSource);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['main.ts']);
});

test('listDirectory never lists through a real symlink or junction out of the project', async () => {
  const projectRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-project-'));
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.mkdir(path.join(projectRoot, 'inside'));
    // `junction` is what Windows creates without developer mode; elsewhere it is ignored.
    await fsPromises.symlink(outsideDirectory, path.join(projectRoot, 'escape'), 'junction');

    const service = createRealFileSystemService(projectRoot);
    const rootListing = await service.listDirectory('project-1', {
      directoryPath: null, offset: 0, limit: 500, respectGitignore: false,
    });
    // The link is shown, as before, but as a non-expandable entry.
    const escapeEntry = rootListing.entries.find((entry) => entry.name === 'escape');
    assert.equal(escapeEntry?.type, 'file');
    assert.equal(escapeEntry?.isSymlink, true);

    await assert.rejects(
      service.listDirectory('project-1', {
        directoryPath: path.join(projectRoot, 'escape'), offset: 0, limit: 500, respectGitignore: false,
      }),
      isOutsideProjectError,
    );

    const search = await service.searchProjectFiles('project-1', {
      query: 'secret', match: 'path', filesOnly: false, limit: 100, respectGitignore: false,
    });
    assert.deepEqual(search.results, []);
  } finally {
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('searchProjectFiles returns matches in tree order with project-relative paths', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const { fileSystem } = createFakeProjectFileSystem(projectRoot, sampleLayout);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const byPath = await service.searchProjectFiles('project-1', {
    query: 'LOGO', match: 'path', filesOnly: true, limit: 100, respectGitignore: true,
  });
  // `build/` is a fallback-ignored folder and `node_modules/` a hard exclusion.
  assert.deepEqual(byPath.results.map((result) => result.relativePath), [
    'assets/logo-128.png',
    'src/lib/logo.ts',
    'src/logo-helper.ts',
  ]);
  assert.equal(byPath.truncated, false);
  assert.equal(byPath.results[0]?.path, path.join(projectRoot, 'assets', 'logo-128.png'));
  assert.equal(byPath.results[0]?.permissions, '644');

  const folders = await service.searchProjectFiles('project-1', {
    query: 'li', match: 'name', filesOnly: false, limit: 100, respectGitignore: true,
  });
  assert.deepEqual(folders.results.map((result) => [result.relativePath, result.type]), [['src/lib', 'directory']]);

  const exact = await service.searchProjectFiles('project-1', {
    query: 'logo.ts', match: 'basename', filesOnly: true, limit: 100, respectGitignore: true,
  });
  assert.deepEqual(exact.results.map((result) => result.relativePath), ['src/lib/logo.ts']);
});

test('searchProjectFiles with an empty query lists the first files and reports truncation', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const { fileSystem } = createFakeProjectFileSystem(projectRoot, sampleLayout);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const firstTwo = await service.searchProjectFiles('project-1', {
    query: '', match: 'path', filesOnly: true, limit: 2, respectGitignore: true,
  });
  assert.deepEqual(firstTwo.results.map((result) => result.relativePath), ['assets/banner.png', 'assets/logo-128.png']);
  assert.equal(firstTwo.truncated, true);

  const everything = await service.searchProjectFiles('project-1', {
    query: '', match: 'path', filesOnly: true, limit: 100, respectGitignore: true,
  });
  assert.equal(everything.results.length, 6);
  assert.equal(everything.truncated, false);
});

test('searchProjectFiles honours the project gitignore when asked', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const { fileSystem } = createFakeProjectFileSystem(projectRoot, sampleLayout, {
    readTextFile: async () => 'assets/\n',
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.searchProjectFiles('project-1', {
    query: 'logo', match: 'path', filesOnly: true, limit: 100, respectGitignore: true,
  });
  // `assets/` is ignored now, and `build/` is no longer excluded by name.
  assert.deepEqual(result.results.map((entry) => entry.relativePath), [
    'build/logo-built.png',
    'src/lib/logo.ts',
    'src/logo-helper.ts',
  ]);
});

test('searchProjectFiles stops when its signal is aborted', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const { fileSystem } = createFakeProjectFileSystem(projectRoot, sampleLayout);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));
  const abortController = new AbortController();
  abortController.abort();

  await assert.rejects(
    service.searchProjectFiles('project-1', {
      query: 'logo', match: 'path', filesOnly: true, limit: 100, respectGitignore: true, signal: abortController.signal,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'FILE_TREE_SEARCH_ABORTED',
  );
});

test('a search that stops early leaves only a few subfolder reads behind', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const layout: Record<string, Array<[string, boolean]>> = {
    '': Array.from({ length: 1_000 }, (_, index): [string, boolean] => [`folder-${String(index).padStart(4, '0')}`, true]),
  };
  for (let index = 0; index < 1_000; index += 1) {
    layout[`folder-${String(index).padStart(4, '0')}`] = [['match.txt', false]];
  }
  const { fileSystem, readDirectories } = createFakeProjectFileSystem(projectRoot, layout);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.searchProjectFiles('project-1', {
    query: 'match', match: 'name', filesOnly: true, limit: 2, respectGitignore: false,
  });
  assert.deepEqual(result.results.map((entry) => entry.relativePath), [
    'folder-0000/match.txt',
    'folder-0001/match.txt',
  ]);
  assert.equal(result.truncated, true);
  // Let any read-ahead still queued finish before counting.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(readDirectories.length < 40, `read ${readDirectories.length} directories`);
});
