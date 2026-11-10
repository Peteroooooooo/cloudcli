import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@/shared/api';
import type { FileTreeNode, FileTreeSearchResult } from '@/shared/types';
import { readFileSearchResponse } from '@/shared/utils';

// Typing pauses this long before the server is asked, and every newer query
// aborts the request before it, so a fast typist sends one search, not ten.
const SEARCH_DEBOUNCE_MS = 250;
// Enough to fill the panel several times over; past it the tree says that
// more matches exist and the search should be narrowed.
const SEARCH_RESULT_LIMIT = 200;

type UseFileTreeSearchArgs = {
  projectId: string | undefined;
  // Metadata for the folders between the root and a hit, when already loaded.
  findLoadedNode: (entryPath: string) => FileTreeNode | undefined;
};

type UseFileTreeSearchResult = {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  isSearchActive: boolean;
  searching: boolean;
  truncated: boolean;
  searchResultTree: FileTreeNode[];
  searchExpandedDirs: Set<string>;
  toggleSearchDirectory: (directoryPath: string) => void;
  rerunSearch: () => void;
};

type SearchOutcome = {
  projectId: string;
  query: string;
  tree: FileTreeNode[];
  directoryPaths: string[];
  truncated: boolean;
};

/**
 * Rebuilds the folders around each hit so the results read like the tree
 * they came from. Hits arrive in fully expanded tree order, so appending each
 * one to its parent keeps folders before files and names sorted.
 */
function buildSearchResultTree(
  results: FileTreeSearchResult[],
  findLoadedNode: (entryPath: string) => FileTreeNode | undefined,
): { tree: FileTreeNode[]; directoryPaths: string[] } {
  const tree: FileTreeNode[] = [];
  const nodesByPath = new Map<string, FileTreeNode & { children: FileTreeNode[] }>();

  for (const result of results) {
    const segments = result.relativePath.split('/');
    // Each ancestor's absolute path is the hit's path with the trailing
    // segments (and their separators) removed, which keeps the server's own
    // separator and drive-letter spelling.
    const ancestorPaths: string[] = [];
    let cursor = result.path;
    for (let index = segments.length - 1; index > 0; index -= 1) {
      cursor = cursor.slice(0, cursor.length - segments[index].length - 1);
      ancestorPaths.unshift(cursor);
    }

    let siblings = tree;
    ancestorPaths.forEach((ancestorPath, index) => {
      let ancestor = nodesByPath.get(ancestorPath);
      if (!ancestor) {
        const loadedAncestor = findLoadedNode(ancestorPath)
          ?? { name: segments[index], path: ancestorPath, type: 'directory' as const };
        // Only the matching descendants are shown, as the old filter did.
        ancestor = { ...loadedAncestor, children: [] };
        nodesByPath.set(ancestorPath, ancestor);
        siblings.push(ancestor);
      }
      siblings = ancestor.children;
    });

    if (!nodesByPath.has(result.path)) {
      const node = { ...result, children: [] as FileTreeNode[] };
      if (result.type === 'directory') {
        nodesByPath.set(result.path, node);
        siblings.push(node);
      } else {
        siblings.push({ ...result });
      }
    }
  }

  const directoryPaths = [...nodesByPath.values()]
    .filter((node) => node.children.length > 0)
    .map((node) => node.path);
  return { tree, directoryPaths };
}

export function useFileTreeSearch({
  projectId,
  findLoadedNode,
}: UseFileTreeSearchArgs): UseFileTreeSearchResult {
  const [searchQuery, setSearchQuery] = useState('');
  // The last answer from the server, kept with the query it answers so a
  // stale tree is never shown for a different search once the new one lands.
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  // Folders the user folded inside the current results; every result folder
  // starts open, as the old in-memory filter showed them.
  const [collapsedSearchDirs, setCollapsedSearchDirs] = useState<Set<string>>(() => new Set());
  // Bumped after a file operation so open results reflect the change.
  const [searchRevision, setSearchRevision] = useState(0);

  const trimmedQuery = searchQuery.trim();
  const isSearchActive = trimmedQuery !== '';

  useEffect(() => {
    if (!projectId || !trimmedQuery) {
      setOutcome(null);
      return;
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await api.searchFiles(
            projectId,
            { q: trimmedQuery, match: 'name', limit: SEARCH_RESULT_LIMIT },
            { signal: abortController.signal },
          );
          const body = readFileSearchResponse(response.ok ? await response.json() : null);
          if (abortController.signal.aborted) {
            return;
          }
          const { tree, directoryPaths } = buildSearchResultTree(body.results, findLoadedNode);
          setCollapsedSearchDirs(new Set());
          setOutcome({ projectId, query: trimmedQuery, tree, directoryPaths, truncated: body.truncated });
        } catch (error) {
          if ((error as { name?: string }).name === 'AbortError') {
            return;
          }
          console.error('Error searching files:', error);
          setOutcome({ projectId, query: trimmedQuery, tree: [], directoryPaths: [], truncated: false });
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      abortController.abort();
    };
    // `findLoadedNode` changes whenever a folder loads; re-searching for that
    // would cost a request for metadata the results do not depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, trimmedQuery, searchRevision]);

  const searchExpandedDirs = useMemo(
    () => new Set((outcome && outcome.projectId === projectId ? outcome.directoryPaths : [])
      .filter((directoryPath) => !collapsedSearchDirs.has(directoryPath))),
    [outcome, projectId, collapsedSearchDirs],
  );

  const toggleSearchDirectory = useCallback((directoryPath: string) => {
    setCollapsedSearchDirs((previous) => {
      const next = new Set(previous);
      if (next.has(directoryPath)) {
        next.delete(directoryPath);
      } else {
        next.add(directoryPath);
      }
      return next;
    });
  }, []);

  const rerunSearch = useCallback(() => {
    setSearchRevision((revision) => revision + 1);
  }, []);

  // The answer to this exact query in this project. A project switch keeps
  // the search text, so another project's results are never shown for it.
  const currentOutcome = outcome?.query === trimmedQuery && outcome.projectId === projectId ? outcome : null;
  const shownOutcome = outcome?.projectId === projectId ? outcome : null;

  return {
    searchQuery,
    setSearchQuery,
    isSearchActive,
    // Until the answer for exactly this query lands, the tree shows the
    // previous results (or "searching") instead of a premature "no matches".
    searching: isSearchActive && !currentOutcome,
    truncated: Boolean(shownOutcome?.truncated),
    searchResultTree: shownOutcome?.tree ?? [],
    searchExpandedDirs,
    toggleSearchDirectory,
    rerunSearch,
  };
}
