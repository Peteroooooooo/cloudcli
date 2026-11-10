import { useEffect, useMemo, useState } from 'react';

import { api } from '@/shared/api';
import { readFileSearchResponse } from '@/shared/utils';
import { useApiSource } from '@/modules/command-palette/hooks/useApiSource';

export type FileResult = {
  path: string;
  name: string;
};

// The palette opens on the project's first files in tree order, as it always
// did; the server walks only as far as it needs to find them.
const MAX_FILES = 500;
// Typed text is also searched on the server, so a file past the first 500 of
// a large project can still be found.
const SEARCH_RESULT_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 200;

const toFileResults = (data: unknown): FileResult[] =>
  readFileSearchResponse(data).results.map((result) => ({ path: result.path, name: result.name }));

export function useFilesSource(projectId: string | undefined, enabled: boolean, searchText = '') {
  const isEnabled = enabled && !!projectId;
  const baseFiles = useApiSource<FileResult, unknown>({
    enabled: isEnabled,
    deps: [projectId],
    fetcher: (signal) => api.searchFiles(projectId!, { q: '', filesOnly: true, limit: MAX_FILES }, { signal }),
    parse: toFileResults,
  });

  // Server matches for the typed text; the palette's own fuzzy filter still
  // ranks them together with the files above.
  const [searchedFiles, setSearchedFiles] = useState<FileResult[]>([]);
  const trimmedSearch = searchText.trim();

  useEffect(() => {
    if (!isEnabled || !trimmedSearch) {
      setSearchedFiles([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.searchFiles(projectId!, { q: trimmedSearch, filesOnly: true, limit: SEARCH_RESULT_LIMIT }, {
        signal: controller.signal,
      })
        .then((response) => response.json())
        .then((data: unknown) => {
          if (!controller.signal.aborted) {
            setSearchedFiles(toFileResults(data));
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchedFiles([]);
          }
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [isEnabled, projectId, trimmedSearch]);

  // Server matches come first: the palette's main page shows only the first
  // few files before its own filter runs, so matches placed after the 500
  // browse files would never be seen there.
  return useMemo(() => {
    if (searchedFiles.length === 0) {
      return baseFiles;
    }
    const searchedPaths = new Set(searchedFiles.map((file) => file.path));
    return [...searchedFiles, ...baseFiles.filter((file) => !searchedPaths.has(file.path))];
  }, [baseFiles, searchedFiles]);
}
