import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type {
  FileTreeDirectoryListing,
  FileTreeDirectoryStatus,
  FileTreeNode,
  Project,
} from '@/shared/types';

// Children fetched per request. A folder with more shows a "show more" row, so
// one folder with tens of thousands of entries never floods the phone UI.
const DIRECTORY_PAGE_SIZE = 500;
// The server's largest page; a refresh re-reads at most this many rows of a
// folder the user already paged through.
const MAXIMUM_DIRECTORY_PAGE_SIZE = 2_000;
// Cache key of the project root, which the API lists when no path is given.
const ROOT_DIRECTORY_KEY = '';

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

type DirectoryContents = {
  entries: FileTreeNode[];
  total: number;
  hasMore: boolean;
};

type DirectoryRequestState = {
  loading: boolean;
  error: string | null;
};

type UseFileTreeDataResult = {
  // The loaded part of the tree: each loaded folder carries its `children`.
  files: FileTreeNode[];
  loading: boolean;
  error: string | null;
  refreshFiles: () => void;
  refreshDirectory: (directoryPath: string, options?: { withDescendants?: boolean }) => void;
  refreshParentDirectory: (entryPath: string) => void;
  loadMoreEntries: (directoryPath: string) => void;
  getDirectoryStatus: (directoryPath: string) => FileTreeDirectoryStatus;
  findLoadedNode: (entryPath: string) => FileTreeNode | undefined;
};

// The API reports refusals as { error: message }. Surfacing that message tells
// the user why the tree is missing instead of leaving an unexplained empty tree.
function readResponseErrorMessage(responseBody: string): string | null {
  try {
    const parsedBody = JSON.parse(responseBody) as unknown;
    const message = typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody
      ? (parsedBody as { error: unknown }).error
      : null;
    return typeof message === 'string' && message.trim() ? message : null;
  } catch {
    return null;
  }
}

// Paths reach this hook from the server (platform separators) and from the
// upload code (`/`-joined), so keys are compared in one canonical spelling.
// Windows paths compare case-insensitively, as the filesystem does.
function normalizeDirectoryPath(directoryPath: string): string {
  const slashed = directoryPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
}

function isDescendantKey(candidateKey: string, ancestorKey: string): boolean {
  if (ancestorKey === ROOT_DIRECTORY_KEY) {
    return candidateKey !== ROOT_DIRECTORY_KEY;
  }
  return candidateKey.startsWith(`${ancestorKey}/`) || candidateKey.startsWith(`${ancestorKey}\\`);
}

function mergePages(previousEntries: FileTreeNode[], nextEntries: FileTreeNode[]): FileTreeNode[] {
  // A file created between two page requests can shift one entry across the
  // page boundary; the path keeps it from being shown twice.
  const seenPaths = new Set(previousEntries.map((entry) => entry.path));
  return [...previousEntries, ...nextEntries.filter((entry) => !seenPaths.has(entry.path))];
}

/**
 * Loads the project tree one folder at a time: the root when the project
 * opens, and each folder the first time it is expanded. Loaded folders stay
 * cached; refreshes re-read only the folders that are visible and expanded.
 */
export function useFileTreeData(
  selectedProject: Project | null,
  expandedDirs: Set<string>,
): UseFileTreeDataResult {
  const projectId = selectedProject?.projectId;
  // Every folder fetched so far, keyed by the path the server returned for it
  // (the root under ROOT_DIRECTORY_KEY); the source the visible tree is built from.
  const [directories, setDirectories] = useState<Map<string, DirectoryContents>>(() => new Map());
  // In-flight and failed folder requests, so a row can show "loading" or the
  // error, and an expanded folder is fetched once rather than on every render.
  const [directoryRequests, setDirectoryRequests] = useState<Map<string, DirectoryRequestState>>(() => new Map());
  // The project root as the server spells it, needed to map a root-level
  // path from the upload code back to the root's cache key.
  const [rootPath, setRootPath] = useState<string | null>(null);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const projectIdRef = useRef(projectId);

  const setRequestState = useCallback((directoryKey: string, requestState: DirectoryRequestState | null) => {
    setDirectoryRequests((previous) => {
      const next = new Map(previous);
      if (requestState) {
        next.set(directoryKey, requestState);
      } else {
        next.delete(directoryKey);
      }
      return next;
    });
  }, []);

  const loadDirectory = useCallback(async (
    directoryKey: string,
    { offset = 0, limit = DIRECTORY_PAGE_SIZE, append = false }: { offset?: number; limit?: number; append?: boolean } = {},
  ) => {
    const requestProjectId = projectIdRef.current;
    if (!requestProjectId) {
      return;
    }

    abortControllersRef.current.get(directoryKey)?.abort();
    const abortController = new AbortController();
    abortControllersRef.current.set(directoryKey, abortController);
    setRequestState(directoryKey, { loading: true, error: null });

    const isCurrent = () =>
      !abortController.signal.aborted && projectIdRef.current === requestProjectId;

    try {
      const response = await api.listDirectory(
        requestProjectId,
        { path: directoryKey || null, offset, limit },
        { signal: abortController.signal },
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('File listing failed:', response.status, errorText);
        if (isCurrent()) {
          setRequestState(directoryKey, {
            loading: false,
            error: readResponseErrorMessage(errorText) ?? DEFAULT_LOAD_ERROR,
          });
        }
        return;
      }

      const listing = (await response.json()) as FileTreeDirectoryListing;
      if (!isCurrent()) {
        return;
      }

      if (directoryKey === ROOT_DIRECTORY_KEY) {
        setRootPath(listing.path);
      }
      setDirectories((previous) => {
        const next = new Map(previous);
        const previousContents = previous.get(directoryKey);
        next.set(directoryKey, {
          entries: append && previousContents
            ? mergePages(previousContents.entries, listing.entries)
            : listing.entries,
          total: listing.total,
          hasMore: listing.hasMore,
        });
        return next;
      });
      setRequestState(directoryKey, null);
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') {
        return;
      }
      console.error('Error fetching files:', error);
      if (isCurrent()) {
        setRequestState(directoryKey, { loading: false, error: DEFAULT_LOAD_ERROR });
      }
    } finally {
      if (abortControllersRef.current.get(directoryKey) === abortController) {
        abortControllersRef.current.delete(directoryKey);
      }
    }
  }, [setRequestState]);

  // A new project starts from an empty cache and lists only its root.
  useEffect(() => {
    projectIdRef.current = projectId;
    const abortControllers = abortControllersRef.current;
    abortControllers.forEach((controller) => controller.abort());
    abortControllers.clear();
    setDirectories(new Map());
    setDirectoryRequests(new Map());
    setRootPath(null);

    if (projectId) {
      void loadDirectory(ROOT_DIRECTORY_KEY);
    }

    return () => {
      abortControllers.forEach((controller) => controller.abort());
      abortControllers.clear();
    };
  }, [projectId, loadDirectory]);

  /**
   * Builds the visible tree from the cache. Along the way it records each
   * entry's parent folder key and which expanded folders are actually on
   * screen (every ancestor expanded too), the only folders worth fetching.
   */
  const composedTree = useMemo(() => {
    const nodesByPath = new Map<string, FileTreeNode>();
    const parentKeyByPath = new Map<string, string>();
    const visibleExpandedPaths: string[] = [];

    const compose = (entries: FileTreeNode[], parentKey: string, parentVisible: boolean): FileTreeNode[] =>
      entries.map((entry) => {
        parentKeyByPath.set(entry.path, parentKey);
        const contents = entry.type === 'directory' ? directories.get(entry.path) : undefined;
        const isVisibleExpanded = parentVisible && entry.type === 'directory' && expandedDirs.has(entry.path);
        if (isVisibleExpanded) {
          visibleExpandedPaths.push(entry.path);
        }
        const node = contents
          ? { ...entry, children: compose(contents.entries, entry.path, isVisibleExpanded) }
          : entry;
        nodesByPath.set(entry.path, node);
        return node;
      });

    const rootContents = directories.get(ROOT_DIRECTORY_KEY);
    const files = rootContents ? compose(rootContents.entries, ROOT_DIRECTORY_KEY, true) : [];
    return { files, nodesByPath, parentKeyByPath, visibleExpandedPaths };
  }, [directories, expandedDirs]);

  // Fetch every expanded folder that is on screen and not cached yet: a click,
  // a "reveal this folder" request and a refresh all land here. A failed folder
  // is not retried until the user refreshes.
  useEffect(() => {
    composedTree.visibleExpandedPaths.forEach((directoryPath) => {
      if (!directories.has(directoryPath) && !directoryRequests.has(directoryPath)) {
        void loadDirectory(directoryPath);
      }
    });
  }, [composedTree, directories, directoryRequests, loadDirectory]);

  // Re-reads as many rows as are already shown, so a refresh does not fold a
  // folder the user paged through back to its first page.
  const refreshLimitFor = useCallback((directoryKey: string) => Math.min(
    MAXIMUM_DIRECTORY_PAGE_SIZE,
    Math.max(DIRECTORY_PAGE_SIZE, directories.get(directoryKey)?.entries.length ?? 0),
  ), [directories]);

  const resolveDirectoryKey = useCallback((directoryPath: string): string | null => {
    if (!directoryPath) {
      return ROOT_DIRECTORY_KEY;
    }
    if (directories.has(directoryPath)) {
      return directoryPath;
    }
    const normalizedPath = normalizeDirectoryPath(directoryPath);
    if (rootPath && normalizeDirectoryPath(rootPath) === normalizedPath) {
      return ROOT_DIRECTORY_KEY;
    }
    for (const directoryKey of directories.keys()) {
      if (directoryKey && normalizeDirectoryPath(directoryKey) === normalizedPath) {
        return directoryKey;
      }
    }
    // Never loaded, so there is nothing stale to re-read.
    return null;
  }, [directories, rootPath]);

  const refreshFiles = useCallback(() => {
    const keysToReload = [ROOT_DIRECTORY_KEY, ...composedTree.visibleExpandedPaths.filter((key) => directories.has(key))];
    const limits = new Map(keysToReload.map((key) => [key, refreshLimitFor(key)]));
    const keep = new Set(keysToReload);
    // Collapsed folders are forgotten and fetched fresh when opened again.
    setDirectories((previous) => new Map([...previous].filter(([key]) => keep.has(key))));
    setDirectoryRequests(new Map());
    keysToReload.forEach((key) => {
      void loadDirectory(key, { limit: limits.get(key) });
    });
  }, [composedTree, directories, loadDirectory, refreshLimitFor]);

  const refreshDirectory = useCallback((
    directoryPath: string,
    { withDescendants = false }: { withDescendants?: boolean } = {},
  ) => {
    const directoryKey = resolveDirectoryKey(directoryPath);
    if (directoryKey === null) {
      return;
    }
    const visibleExpanded = new Set(composedTree.visibleExpandedPaths);
    const keysToReload = [directoryKey];
    if (withDescendants) {
      // An upload can add files to subfolders that are already open.
      for (const key of directories.keys()) {
        if (isDescendantKey(key, directoryKey) && visibleExpanded.has(key)) {
          keysToReload.push(key);
        }
      }
      setDirectories((previous) => new Map([...previous].filter(([key]) =>
        !isDescendantKey(key, directoryKey) || visibleExpanded.has(key))));
    }
    keysToReload.forEach((key) => {
      void loadDirectory(key, { limit: refreshLimitFor(key) });
    });
  }, [composedTree, directories, loadDirectory, refreshLimitFor, resolveDirectoryKey]);

  const refreshParentDirectory = useCallback((entryPath: string) => {
    const parentKey = composedTree.parentKeyByPath.get(entryPath)
      ?? entryPath.replace(/[\\/][^\\/]*$/, '');
    const cachedParentKey = resolveDirectoryKey(parentKey);
    // A renamed or deleted folder's cached contents no longer exist under
    // that path; dropping them keeps them from reappearing. The entry also
    // leaves its parent's cached rows until the parent is re-read, so a folder
    // that is still marked expanded is not fetched again under its old path.
    setDirectories((previous) => {
      const next = new Map([...previous].filter(([key]) =>
        key !== entryPath && !isDescendantKey(key, entryPath)));
      const parentContents = cachedParentKey === null ? undefined : next.get(cachedParentKey);
      if (cachedParentKey !== null && parentContents) {
        const entries = parentContents.entries.filter((entry) => entry.path !== entryPath);
        next.set(cachedParentKey, {
          ...parentContents,
          entries,
          total: parentContents.total - (parentContents.entries.length - entries.length),
        });
      }
      return next;
    });
    refreshDirectory(parentKey);
  }, [composedTree, refreshDirectory, resolveDirectoryKey]);

  const loadMoreEntries = useCallback((directoryPath: string) => {
    const directoryKey = resolveDirectoryKey(directoryPath);
    const contents = directoryKey === null ? undefined : directories.get(directoryKey);
    if (directoryKey === null || !contents || directoryRequests.get(directoryKey)?.loading) {
      return;
    }
    void loadDirectory(directoryKey, { offset: contents.entries.length, append: true });
  }, [directories, directoryRequests, loadDirectory, resolveDirectoryKey]);

  const getDirectoryStatus = useCallback((directoryPath: string): FileTreeDirectoryStatus => {
    const contents = directories.get(directoryPath);
    const requestState = directoryRequests.get(directoryPath);
    return {
      loaded: Boolean(contents),
      loading: requestState?.loading ?? false,
      error: requestState?.error ?? null,
      remaining: contents?.hasMore ? Math.max(0, contents.total - contents.entries.length) : 0,
    };
  }, [directories, directoryRequests]);

  const findLoadedNode = useCallback(
    (entryPath: string) => composedTree.nodesByPath.get(entryPath),
    [composedTree],
  );

  const rootRequest = directoryRequests.get(ROOT_DIRECTORY_KEY);
  const rootLoaded = directories.has(ROOT_DIRECTORY_KEY);

  return {
    files: composedTree.files,
    loading: Boolean(projectId) && !rootLoaded && !rootRequest?.error,
    error: rootRequest?.error ?? null,
    refreshFiles,
    refreshDirectory,
    refreshParentDirectory,
    loadMoreEntries,
    getDirectoryStatus,
    findLoadedNode,
  };
}
