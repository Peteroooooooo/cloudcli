import path from 'node:path';

import ignore from 'ignore';

import type {
  FileTreeDirectoryEntry,
  FileTreeNode,
  FileTreeSearchInput,
  FileTreeSearchResponse,
  FileTreeSearchResult,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import {
  AppError,
  FORBIDDEN_WORKSPACE_PATHS,
  normalizeProjectPath,
  resolvePathUnderRoots,
} from '@/shared/utils.js';

const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ...HARD_EXCLUDED_DIRECTORY_NAMES,
  'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor',
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

const COMMON_WORKSPACE_DIRECTORY_NAMES = [
  'Desktop',
  'Documents',
  'Projects',
  'Development',
  'Dev',
  'Code',
  'workspace',
];

// File Tree consumes this guard when recursively listing a project so a very
// broad workspace (for example, a user's home directory) cannot exhaust the
// server heap before the browser has a chance to switch to a narrower project.
const MAXIMUM_FILE_TREE_ENTRIES = 10_000;

// The on-demand listing reads one directory's names in full before sorting
// and paging them. Past this many visible entries the scan stops, so a folder
// with millions of children cannot exhaust the heap; the listing then reports
// `truncated` and pages over what was read.
const MAXIMUM_DIRECTORY_SCAN_ENTRIES = 200_000;

// A project-wide search stops after visiting this many visible entries or
// after this long, whichever comes first, and reports `truncated` so the
// browser can say that more matches may exist.
const SEARCH_ENTRY_BUDGET = 500_000;
const SEARCH_TIME_BUDGET_MS = 5_000;
// Subfolder listings each folder of the search walk reads ahead.
const SEARCH_PREFETCH_DIRECTORIES = 16;

// `String.prototype.localeCompare` without arguments uses this same default
// collator; reusing one instance keeps the order identical to the full tree's
// while sorting a 40k-entry folder in a fraction of the time.
const ENTRY_NAME_COLLATOR = new Intl.Collator();

function compareDirectoryEntries(
  left: { name: string; isDirectory: boolean },
  right: { name: string; isDirectory: boolean },
): number {
  if (left.isDirectory !== right.isDirectory) {
    return left.isDirectory ? -1 : 1;
  }
  return ENTRY_NAME_COLLATOR.compare(left.name, right.name);
}

// True when `candidatePath` is `rootPath` or lies under it. `path.relative`
// compares drive letters case-insensitively on win32 and returns an absolute
// path for another drive.
function isSameOrInsidePath(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === ''
    || (relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath));
}

function createSearchAbortError(): AppError {
  return createFileTreeError('Search was cancelled', 499, 'FILE_TREE_SEARCH_ABORTED');
}

// Largest file the text viewer/editor endpoint reads. Downloads and media
// previews stream through `openFile` and are not limited by this.
const MAXIMUM_TEXT_FILE_BYTES = 5 * 1024 * 1024;

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
}

type FileTreeEntryFilter = (entryPath: string, isDirectory: boolean) => boolean;

function includeEntryByHardExclusions(entryPath: string, isDirectory: boolean): boolean {
  return !isDirectory || !HARD_EXCLUDED_DIRECTORY_NAMES.has(path.basename(entryPath));
}

function includeEntryByFallbackDirectoryNames(entryPath: string, isDirectory: boolean): boolean {
  return includeEntryByHardExclusions(entryPath, isDirectory)
    && (!isDirectory || !IGNORED_DIRECTORY_NAMES.has(path.basename(entryPath)));
}

function createFileTreeError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, { statusCode, code });
}

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionBitsToRwx(permissionBits: number): string {
  const read = permissionBits & 4 ? 'r' : '-';
  const write = permissionBits & 2 ? 'w' : '-';
  const execute = permissionBits & 1 ? 'x' : '-';
  return read + write + execute;
}

function validateFilename(name: string): void {
  if (!name.trim()) {
    throw createFileTreeError('Filename cannot be empty', 400, 'INVALID_FILENAME');
  }

  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw createFileTreeError('Filename contains invalid characters', 400, 'INVALID_FILENAME');
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    throw createFileTreeError('Filename is a reserved name', 400, 'INVALID_FILENAME');
  }

  if (/^\.+$/.test(name)) {
    throw createFileTreeError('Filename cannot be only dots', 400, 'INVALID_FILENAME');
  }
}

function resolvePathInsideProject(projectRoot: string, targetPath: string): string {
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  // `path.relative` compares case-insensitively on win32, where VS Code writes
  // `d:\` for a root stored as `D:\`, and handles a drive-root project. It
  // returns an absolute path for another drive and starts with `..` outside.
  const relativePath = path.relative(path.resolve(projectRoot), resolvedPath);
  const isInsideProject = relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);

  if (!isInsideProject) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

function expandWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath === '~') {
    return workspaceRoot;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(workspaceRoot, inputPath.slice(2));
  }
  return inputPath;
}

function createConcurrencyLimiter(maximumConcurrency: number) {
  let activeOperations = 0;
  const pendingOperations: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeOperations < maximumConcurrency) {
      activeOperations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      pendingOperations.push(resolve);
    });
  }

  function release(): void {
    const nextOperation = pendingOperations.shift();
    if (nextOperation) {
      nextOperation();
      return;
    }

    activeOperations = Math.max(0, activeOperations - 1);
  }

  return { acquire, release };
}

function mapFileSystemError(
  error: unknown,
  messages: Partial<Record<string, { message: string; statusCode: number }>>,
): never {
  const errorCode = readErrorCode(error);
  const mappedError = errorCode ? messages[errorCode] : undefined;
  if (mappedError) {
    throw createFileTreeError(mappedError.message, mappedError.statusCode, errorCode ?? 'FILE_TREE_ERROR');
  }

  throw error;
}

function createGitignoreEntryFilter(
  projectRoot: string,
  gitignoreContent: string,
): FileTreeEntryFilter {
  const gitignore = ignore().add(gitignoreContent);

  return (entryPath, isDirectory) => {
    if (!includeEntryByHardExclusions(entryPath, isDirectory)) return false;

    const relativePath = path.relative(projectRoot, entryPath).split(path.sep).join('/');
    const matchPath = isDirectory ? `${relativePath}/` : relativePath;
    return !gitignore.ignores(matchPath);
  };
}

/**
 * Creates File Tree workflows for the module composition root and route tests.
 * Every filesystem, project, workspace, environment, and logging dependency is
 * required explicitly so this service has no machine-wide production defaults.
 */
export function createFileTreeService(dependencies: FileTreeServiceDependencies): FileTreeServices {
  const fileSystem = dependencies.fileSystem;
  const concurrencyLimit = Number.isFinite(dependencies.fileSystemConcurrency)
    && dependencies.fileSystemConcurrency > 0
    ? Math.floor(dependencies.fileSystemConcurrency)
    : 1;
  const { acquire, release } = createConcurrencyLimiter(concurrencyLimit);

  async function resolveProjectRoot(projectId: string): Promise<string> {
    const projectRoot = await dependencies.projects.getProjectPathById(projectId);
    if (!projectRoot) {
      throw createFileTreeError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }
    return projectRoot;
  }

  /**
   * Streams one directory and keeps only the entries the tree will show.
   *
   * Entries are filtered and charged against the shared budget one at a time,
   * so a pathologically large directory stops the walk at the cap instead of
   * being read into memory in full first.
   */
  async function collectVisibleEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
    remainingEntries: { value: number },
  ): Promise<FileTreeDirectoryEntry[]> {
    const visibleEntries: FileTreeDirectoryEntry[] = [];

    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        const isDirectory = entry.isDirectory();
        if (!includeEntry(path.join(directoryPath, entry.name), isDirectory)) {
          continue;
        }

        // Charged after visibility filtering so ignored entries never consume
        // the budget. Every recursive branch shares one counter, so the cap
        // applies to the whole tree rather than per directory.
        if (remainingEntries.value <= 0) {
          throw createFileTreeError(
            `Project file tree exceeds the ${MAXIMUM_FILE_TREE_ENTRIES.toLocaleString()} entry limit. Choose a narrower project directory or add ignore rules.`,
            413,
            'FILE_TREE_TOO_LARGE',
          );
        }
        remainingEntries.value -= 1;
        visibleEntries.push(entry);
      }
    } catch (error) {
      // The entry cap is a caller-visible outcome, not an unreadable directory.
      if (error instanceof AppError) {
        throw error;
      }
      const errorCode = readErrorCode(error);
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
      return [];
    } finally {
      release();
    }

    return visibleEntries;
  }

  /**
   * Builds one tree item with its lstat metadata. Metadata failures leave the
   * zeroed defaults so an otherwise readable entry is never hidden.
   */
  async function describeEntry(itemPath: string, name: string, isDirectory: boolean): Promise<FileTreeNode> {
    const item: FileTreeNode = {
      name,
      path: itemPath,
      type: isDirectory ? 'directory' : 'file',
      size: 0,
      modified: null,
      permissions: '000',
      permissionsRwx: '---------',
    };

    try {
      await acquire();
      try {
        const stats = await fileSystem.lstat(itemPath);
        const ownerPermissions = (stats.mode >> 6) & 7;
        const groupPermissions = (stats.mode >> 3) & 7;
        const otherPermissions = stats.mode & 7;

        item.size = stats.size;
        item.modified = stats.mtime.toISOString();
        item.permissions = `${ownerPermissions}${groupPermissions}${otherPermissions}`;
        item.permissionsRwx = permissionBitsToRwx(ownerPermissions)
          + permissionBitsToRwx(groupPermissions)
          + permissionBitsToRwx(otherPermissions);
        if (stats.isSymbolicLink()) {
          item.isSymlink = true;
        }
      } finally {
        release();
      }
    } catch {
      // Metadata failures should not hide an otherwise readable tree entry.
    }

    return item;
  }

  async function buildFileTree(
    directoryPath: string,
    maximumDepth: number,
    currentDepth = 0,
    includeEntry: FileTreeEntryFilter = includeEntryByFallbackDirectoryNames,
    remainingEntries = { value: MAXIMUM_FILE_TREE_ENTRIES },
  ): Promise<FileTreeNode[]> {
    const visibleEntries = await collectVisibleEntries(directoryPath, includeEntry, remainingEntries);

    const items = await Promise.all(visibleEntries.map(async (entry): Promise<FileTreeNode> => {
      const itemPath = path.join(directoryPath, entry.name);
      const item = await describeEntry(itemPath, entry.name, entry.isDirectory());

      // Skip recursing into pseudo-filesystems and other system-critical
      // directories (e.g. /proc, /sys) — they're never valid project roots,
      // and /proc in particular can contain thousands of virtual entries
      // that make traversal from a broad root (e.g. "/") pathologically slow.
      const isForbiddenSystemDir = FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(itemPath));

      if (entry.isDirectory() && currentDepth < maximumDepth && !isForbiddenSystemDir) {
        item.children = await buildFileTree(
          itemPath,
          maximumDepth,
          currentDepth + 1,
          includeEntry,
          remainingEntries,
        );
      }

      return item;
    }));

    return items.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  }

  /**
   * The visibility rule shared by the full tree, the on-demand listing and the
   * search: the project's root `.gitignore` plus the hard exclusions when
   * requested and present, otherwise the conventional directory names.
   */
  async function resolveEntryFilter(projectRoot: string, respectGitignore: boolean): Promise<FileTreeEntryFilter> {
    if (respectGitignore) {
      try {
        const gitignoreContent = await fileSystem.readTextFile(path.join(projectRoot, '.gitignore'));
        return createGitignoreEntryFilter(projectRoot, gitignoreContent);
      } catch (error) {
        if (readErrorCode(error) !== 'ENOENT') {
          dependencies.logger.error(`Error reading .gitignore in "${projectRoot}"`, error);
        }
      }
    }
    return includeEntryByFallbackDirectoryNames;
  }

  async function resolveExistingProjectRoot(projectId: string): Promise<string> {
    const projectRoot = await resolveProjectRoot(projectId);
    try {
      await fileSystem.access(projectRoot);
    } catch {
      throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
    }
    return projectRoot;
  }

  type VisibleEntry = { name: string; isDirectory: boolean };

  /**
   * Reads one directory's visible entries, sorted folders first and then by
   * name, stopping after `maximumEntries`. Unreadable directories read as
   * empty, like the full tree treats them.
   */
  async function readSortedVisibleEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
    maximumEntries: number,
  ): Promise<{ entries: VisibleEntry[]; capped: boolean }> {
    const entries: VisibleEntry[] = [];
    let capped = false;

    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        const isDirectory = entry.isDirectory();
        if (!includeEntry(path.join(directoryPath, entry.name), isDirectory)) {
          continue;
        }
        if (entries.length >= maximumEntries) {
          capped = true;
          break;
        }
        entries.push({ name: entry.name, isDirectory });
      }
    } catch (error) {
      const errorCode = readErrorCode(error);
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
      return { entries: [], capped: false };
    } finally {
      release();
    }

    entries.sort(compareDirectoryEntries);
    return { entries, capped };
  }

  /**
   * Resolves a directory inside the project for the on-demand listing.
   *
   * The lexical check is `resolvePathInsideProject`, as for every write. A
   * folder can still be a symlink or junction that points out of the project,
   * so the real path of the target must also sit under the real path of the
   * project root before anything in it is listed.
   */
  async function resolveListableDirectory(projectRoot: string, directoryPath: string | null): Promise<string> {
    const resolvedRoot = path.resolve(projectRoot);
    const lexicalPath = !directoryPath
      || path.relative(resolvedRoot, path.resolve(resolvedRoot, directoryPath)) === ''
      ? resolvedRoot
      : resolvePathInsideProject(projectRoot, directoryPath);

    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = await fileSystem.realpath(resolvedRoot);
      realTarget = await fileSystem.realpath(lexicalPath);
    } catch (error) {
      mapFileSystemError(error, {
        ENOENT: { message: 'Directory not found', statusCode: 404 },
        ENOTDIR: { message: 'Path is not a directory', statusCode: 400 },
        EACCES: { message: 'Permission denied', statusCode: 403 },
        EPERM: { message: 'Permission denied', statusCode: 403 },
      });
    }

    if (!isSameOrInsidePath(realRoot, realTarget)) {
      throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
    }

    let isDirectory = false;
    try {
      isDirectory = (await fileSystem.stat(realTarget)).isDirectory();
    } catch (error) {
      mapFileSystemError(error, {
        ENOENT: { message: 'Directory not found', statusCode: 404 },
        EACCES: { message: 'Permission denied', statusCode: 403 },
        EPERM: { message: 'Permission denied', statusCode: 403 },
      });
    }
    if (!isDirectory) {
      throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
    }

    // The lexical path keys every child, so the browser's expanded state and
    // the paths it already holds stay valid.
    return lexicalPath;
  }

  /**
   * Bounded, depth-first, ordered walk for the project search.
   *
   * Results come out in the exact order of a fully expanded tree, so the first
   * N matches are the same N the old full-tree filters produced. Each folder
   * keeps the listings of its next few subfolders in flight, so the walk keeps
   * the disk busy while it consumes those listings strictly in order.
   * Symlinked folders are never descended, matching the full tree.
   */
  async function searchProjectTree(
    projectRoot: string,
    includeEntry: FileTreeEntryFilter,
    input: FileTreeSearchInput,
  ): Promise<FileTreeSearchResponse> {
    const normalizedQuery = input.query.toLowerCase();
    const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
    const matches: Array<{ itemPath: string; name: string; isDirectory: boolean; relativePath: string }> = [];
    let visitedEntries = 0;
    let truncated = false;

    const readDirectory = (directoryPath: string) =>
      readSortedVisibleEntries(directoryPath, includeEntry, MAXIMUM_DIRECTORY_SCAN_ENTRIES);

    const isMatch = (name: string, relativePath: string): boolean => {
      if (!normalizedQuery) return true;
      if (input.match === 'basename') return name.toLowerCase() === normalizedQuery;
      if (input.match === 'name') return name.toLowerCase().includes(normalizedQuery);
      return relativePath.toLowerCase().includes(normalizedQuery);
    };

    // Returns true once the walk must stop (result cap or budget reached).
    async function visit(
      directoryPath: string,
      relativePrefix: string,
      listing: Promise<{ entries: VisibleEntry[]; capped: boolean }>,
    ): Promise<boolean> {
      const { entries, capped } = await listing;
      if (input.signal?.aborted) throw createSearchAbortError();
      if (capped) truncated = true;

      visitedEntries += entries.length;
      if (visitedEntries > SEARCH_ENTRY_BUDGET) {
        truncated = true;
        return true;
      }

      // Pseudo-filesystems such as /proc are never descended, as in the tree.
      const subdirectories = entries.filter((entry) => entry.isDirectory
        && !FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(path.join(directoryPath, entry.name))));
      const subdirectoryListings = new Map<string, Promise<{ entries: VisibleEntry[]; capped: boolean }>>();
      let nextSubdirectoryIndex = 0;
      // Keeps the next few subfolders' listings in flight. The window is small
      // so a walk that stops early (result cap, budget, abort) leaves at most a
      // handful of reads behind instead of one per subfolder of a huge folder.
      const prefetchSubdirectories = () => {
        while (nextSubdirectoryIndex < subdirectories.length
          && subdirectoryListings.size < SEARCH_PREFETCH_DIRECTORIES) {
          const subdirectory = subdirectories[nextSubdirectoryIndex];
          nextSubdirectoryIndex += 1;
          subdirectoryListings.set(subdirectory.name, readDirectory(path.join(directoryPath, subdirectory.name)));
        }
      };
      prefetchSubdirectories();

      for (const entry of entries) {
        if (input.signal?.aborted) throw createSearchAbortError();
        if (Date.now() > deadline) {
          truncated = true;
          return true;
        }

        const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
        const itemPath = path.join(directoryPath, entry.name);
        if ((!input.filesOnly || !entry.isDirectory) && isMatch(entry.name, relativePath)) {
          if (matches.length >= input.limit) {
            truncated = true;
            return true;
          }
          matches.push({ itemPath, name: entry.name, isDirectory: entry.isDirectory, relativePath });
        }

        const subdirectoryListing = subdirectoryListings.get(entry.name);
        if (subdirectoryListing) {
          subdirectoryListings.delete(entry.name);
          prefetchSubdirectories();
          if (await visit(itemPath, relativePath, subdirectoryListing)) {
            return true;
          }
        }
      }

      return false;
    }

    const resolvedRoot = path.resolve(projectRoot);
    await visit(resolvedRoot, '', readDirectory(resolvedRoot));

    const results = await Promise.all(matches.map(async (match): Promise<FileTreeSearchResult> => ({
      ...await describeEntry(match.itemPath, match.name, match.isDirectory),
      relativePath: match.relativePath,
    })));

    return { results, truncated };
  }

  /**
   * Resolves a directory the browser may list.
   *
   * The read-only roots (the system temp directory and the Claude projects
   * directory, see `READ_ONLY_ROOTS` in shared/utils) are browsable but never
   * writable, so they are checked before the workspace policy rejects them.
   * `createWorkspaceFolder` deliberately does not do this, which is what keeps
   * them read-only.
   */
  async function resolveBrowsablePath(targetPath: string): Promise<string> {
    const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
    if (readOnlyPath) {
      return readOnlyPath;
    }

    const validation = await dependencies.workspace.validatePath(targetPath);
    if (!validation.valid) {
      throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
    }

    return validation.resolvedPath || targetPath;
  }

  /**
   * Resolves a path the viewer is allowed to read.
   *
   * A file reference in a transcript is normally inside the project, but a
   * background command's log lives in the system temp directory and a
   * background agent's output file is a link from there into the Claude
   * projects directory, and the transcript quotes those paths verbatim. Those
   * resolve through the read-only root policy instead of the project root.
   *
   * The agent may also point at a file in another folder of the workspace, the
   * same tree `browseWorkspace` lists, so anything under the workspace root is
   * readable too. Symlinks are resolved before that comparison. The writing
   * endpoints keep using `resolvePathInsideProject` alone, so nothing outside
   * the project can be changed.
   */
  async function resolveReadablePath(projectRoot: string, targetPath: string): Promise<string> {
    if (path.isAbsolute(targetPath)) {
      const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
      if (readOnlyPath) {
        return readOnlyPath;
      }

      const workspacePath = await resolvePathUnderRoots(targetPath, [dependencies.workspace.rootPath]);
      if (workspacePath) {
        return workspacePath;
      }
    }

    return resolvePathInsideProject(projectRoot, targetPath);
  }

  async function cleanupTemporaryFiles(files: FileTreeUploadedFile[]): Promise<void> {
    await Promise.all(files.map(async (file) => {
      try {
        await fileSystem.unlink(file.temporaryPath);
      } catch {
        // A successfully moved file no longer has a temporary source to clean.
      }
    }));
  }

  return {
    async browseWorkspace(inputPath) {
      const requestedPath = inputPath
        ? expandWorkspacePath(dependencies.workspace.rootPath, inputPath)
        : dependencies.workspace.rootPath;
      const targetPath = path.resolve(requestedPath);
      const resolvedPath = await resolveBrowsablePath(targetPath);

      try {
        await fileSystem.access(resolvedPath);
        const stats = await fileSystem.stat(resolvedPath);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Directory not accessible', 404, 'DIRECTORY_NOT_ACCESSIBLE');
      }

      const fileTree = await buildFileTree(resolvedPath, 1);
      const directories = fileTree
        .filter((item) => item.type === 'directory')
        .map((item) => ({ path: item.path, name: item.name, type: 'directory' as const }))
        .sort((left, right) => {
          const leftHidden = left.name.startsWith('.');
          const rightHidden = right.name.startsWith('.');
          if (leftHidden && !rightHidden) return 1;
          if (!leftHidden && rightHidden) return -1;
          return left.name.localeCompare(right.name);
        });

      let resolvedWorkspaceRoot = dependencies.workspace.rootPath;
      try {
        resolvedWorkspaceRoot = await fileSystem.realpath(dependencies.workspace.rootPath);
      } catch {
        // The configured workspace root remains the comparison fallback.
      }

      const suggestions = resolvedPath === resolvedWorkspaceRoot
        ? [
            ...directories.filter((directory) => COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
            ...directories.filter((directory) => !COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
          ]
        : directories;

      return { path: resolvedPath, suggestions };
    },

    async createWorkspaceFolder(folderPath) {
      const expandedPath = expandWorkspacePath(dependencies.workspace.rootPath, folderPath);
      const resolvedInput = path.resolve(expandedPath);
      const validation = await dependencies.workspace.validatePath(resolvedInput);
      if (!validation.valid) {
        throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const targetPath = validation.resolvedPath || resolvedInput;
      try {
        await fileSystem.access(path.dirname(targetPath));
      } catch {
        throw createFileTreeError('Parent directory does not exist', 404, 'PARENT_DIRECTORY_NOT_FOUND');
      }

      try {
        await fileSystem.access(targetPath);
        throw createFileTreeError('Folder already exists', 409, 'FOLDER_ALREADY_EXISTS');
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.makeDirectory(targetPath, false);
      } catch (error) {
        mapFileSystemError(error, {
          EEXIST: { message: 'Folder already exists', statusCode: 409 },
        });
      }

      return { success: true, path: targetPath };
    },

    async readTextFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      const fileErrors = {
        ENOENT: { message: 'File not found', statusCode: 404 },
        EACCES: { message: 'Permission denied', statusCode: 403 },
        EISDIR: { message: 'Path is a directory, not a file', statusCode: 400 },
      };
      try {
        // Checked before reading: the whole file is held in memory and sent
        // as one JSON string, which a multi-GB log would exhaust.
        const stats = await fileSystem.stat(resolvedPath);
        if (stats.isDirectory()) {
          throw createFileTreeError(fileErrors.EISDIR.message, fileErrors.EISDIR.statusCode, 'EISDIR');
        }
        if (stats.size > MAXIMUM_TEXT_FILE_BYTES) {
          throw createFileTreeError(
            `File is too large to open in the editor (${formatMegabytes(stats.size)} MB; the limit is ${formatMegabytes(MAXIMUM_TEXT_FILE_BYTES)} MB).`,
            413,
            'FILE_TOO_LARGE',
          );
        }
        const content = await fileSystem.readTextFile(resolvedPath);
        return { content, path: resolvedPath };
      } catch (error) {
        if (error instanceof AppError) throw error;
        mapFileSystemError(error, fileErrors);
      }
    },

    async openFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      try {
        await fileSystem.access(resolvedPath);
      } catch {
        throw createFileTreeError('File not found', 404, 'FILE_NOT_FOUND');
      }

      return {
        contentType: dependencies.resolveMimeType(resolvedPath),
        stream: fileSystem.createReadStream(resolvedPath),
      };
    },

    async saveTextFile(projectId, filePath, content) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, filePath);
      try {
        await fileSystem.writeTextFile(resolvedPath, content);
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
        });
      }

      return { success: true, path: resolvedPath, message: 'File saved successfully' };
    },

    async listProjectFiles(projectId, options) {
      const projectRoot = await resolveExistingProjectRoot(projectId);
      const includeEntry = await resolveEntryFilter(projectRoot, Boolean(options?.respectGitignore));
      return buildFileTree(projectRoot, 10, 0, includeEntry);
    },

    async listDirectory(projectId, input) {
      const projectRoot = await resolveExistingProjectRoot(projectId);
      const directoryPath = await resolveListableDirectory(projectRoot, input.directoryPath);

      // Pseudo-filesystems are shown but never opened, as in the full tree.
      const isForbiddenSystemDirectory = FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(directoryPath));
      const includeEntry = await resolveEntryFilter(projectRoot, input.respectGitignore);
      const { entries, capped } = isForbiddenSystemDirectory
        ? { entries: [], capped: false }
        : await readSortedVisibleEntries(directoryPath, includeEntry, MAXIMUM_DIRECTORY_SCAN_ENTRIES);

      const page = entries.slice(input.offset, input.offset + input.limit);
      const pageEntries = await Promise.all(page.map((entry) =>
        describeEntry(path.join(directoryPath, entry.name), entry.name, entry.isDirectory)));

      return {
        path: directoryPath,
        entries: pageEntries,
        total: entries.length,
        offset: input.offset,
        hasMore: input.offset + page.length < entries.length,
        truncated: capped,
      };
    },

    async searchProjectFiles(projectId, input) {
      const projectRoot = await resolveExistingProjectRoot(projectId);
      const includeEntry = await resolveEntryFilter(projectRoot, input.respectGitignore);
      return searchProjectTree(projectRoot, includeEntry, input);
    },

    async createEntry(input) {
      validateFilename(input.name);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const targetPath = input.parentPath
        ? path.join(input.parentPath, input.name)
        : input.name;
      const resolvedPath = resolvePathInsideProject(projectRoot, targetPath);

      try {
        await fileSystem.access(resolvedPath);
        throw createFileTreeError(
          `${input.type === 'file' ? 'File' : 'Directory'} already exists`,
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        if (input.type === 'directory') {
          await fileSystem.makeDirectory(resolvedPath, false);
        } else {
          const parentDirectory = path.dirname(resolvedPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }
          await fileSystem.writeTextFile(resolvedPath, '');
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'Parent directory not found', statusCode: 404 },
        });
      }

      return {
        success: true,
        path: resolvedPath,
        name: input.name,
        type: input.type,
        message: `${input.type === 'file' ? 'File' : 'Directory'} created successfully`,
      };
    },

    async renameEntry(input) {
      validateFilename(input.newName);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedOldPath = resolvePathInsideProject(projectRoot, input.oldPath);

      try {
        await fileSystem.access(resolvedOldPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      const resolvedNewPath = path.join(path.dirname(resolvedOldPath), input.newName);
      resolvePathInsideProject(projectRoot, resolvedNewPath);
      try {
        await fileSystem.access(resolvedNewPath);
        throw createFileTreeError(
          'A file or directory with this name already exists',
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.rename(resolvedOldPath, resolvedNewPath);
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EXDEV: { message: 'Cannot move across different filesystems', statusCode: 400 },
        });
      }

      return {
        success: true,
        oldPath: resolvedOldPath,
        newPath: resolvedNewPath,
        newName: input.newName,
        message: 'Renamed successfully',
      };
    },

    async deleteEntry(input) {
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, input.targetPath);
      let stats;
      try {
        stats = await fileSystem.stat(resolvedPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      if (resolvedPath === path.resolve(projectRoot)) {
        throw createFileTreeError('Cannot delete project root directory', 403, 'PROJECT_ROOT_DELETE_FORBIDDEN');
      }

      try {
        if (stats.isDirectory()) {
          await fileSystem.removeDirectory(resolvedPath);
        } else {
          await fileSystem.unlink(resolvedPath);
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          ENOTEMPTY: { message: 'Directory is not empty', statusCode: 400 },
        });
      }

      const entryType = stats.isDirectory() ? 'directory' as const : 'file' as const;
      return {
        success: true,
        path: resolvedPath,
        type: entryType,
        message: 'Deleted successfully',
      };
    },

    async storeUploadedFiles(input) {
      if (input.files.length === 0) {
        throw createFileTreeError('No files provided', 400, 'UPLOAD_FILES_REQUIRED');
      }

      try {
        const projectRoot = await resolveProjectRoot(input.projectId);
        const resolvedTargetDirectory = !input.targetPath
          || input.targetPath === '.'
          || input.targetPath === './'
          ? path.resolve(projectRoot)
          : resolvePathInsideProject(projectRoot, input.targetPath);

        try {
          await fileSystem.access(resolvedTargetDirectory);
        } catch {
          await fileSystem.makeDirectory(resolvedTargetDirectory, true);
        }

        const uploadedFiles: Array<{ name: string; path: string; size: number; mimeType: string }> = [];
        for (let fileIndex = 0; fileIndex < input.files.length; fileIndex += 1) {
          const file = input.files[fileIndex];
          const fileName = input.relativePaths[fileIndex] || file.originalName;
          const destinationPath = path.join(resolvedTargetDirectory, fileName);

          try {
            resolvePathInsideProject(projectRoot, destinationPath);
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 403) {
              await cleanupTemporaryFiles([file]);
              continue;
            }
            throw error;
          }

          const parentDirectory = path.dirname(destinationPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }

          await fileSystem.copyFile(file.temporaryPath, destinationPath);
          await fileSystem.unlink(file.temporaryPath);
          uploadedFiles.push({
            name: fileName,
            path: destinationPath,
            size: file.size,
            mimeType: file.mimeType,
          });
        }

        return {
          success: true,
          files: uploadedFiles,
          uploadedCount: uploadedFiles.length,
          requestedFileCount: input.requestedFileCount,
          targetPath: resolvedTargetDirectory,
          message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`,
        };
      } catch (error) {
        await cleanupTemporaryFiles(input.files);
        if (readErrorCode(error) === 'EACCES') {
          throw createFileTreeError('Permission denied', 403, 'EACCES');
        }
        if (error instanceof AppError) throw error;
        dependencies.logger.error(`Error uploading files: ${readErrorMessage(error)}`, error);
        throw error;
      }
    },
  };
}
