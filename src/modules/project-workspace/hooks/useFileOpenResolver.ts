import { useCallback } from 'react';

import { api } from '@/shared/api';
import type { Project } from '@/shared/types';
import { readFileSearchResponse } from '@/shared/utils';

type FlatFile = {
  name: string;
  path: string;
};

// `diffInfo` is intentionally `any` so this resolver can wrap editor handlers
// that expect a concrete diff payload type as well as generic callers.
type OnFileOpen = (filePath: string, diffInfo?: any, line?: number | null) => void;

// Every candidate shares the reference's file name, so this many is plenty
// even for a name like `index.ts` in a large project.
const CANDIDATE_LIMIT = 200;

const normalize = (value: string): string => value.replace(/\\/g, '/');

// Backslashes are already normalized above, so a Windows path arrives as
// `C:/…`; counting it as absolute lets a Windows server resolve it as-is and a
// POSIX one answer an honest 404 instead of opening some other file.
const isAbsoluteRef = (value: string): boolean => /^(\/|[A-Za-z]:\/)/.test(value);

const toTarget = (ref: string): string => normalize(ref).replace(/^\.\//, '').replace(/^\/+/, '');

// References inside chat messages are often bare basenames (`foo.ts`) or partial
// paths (`utils/foo.ts`) rather than full paths, so match by path suffix and
// fall back to filename equality.
const findBestMatch = (files: FlatFile[], ref: string): string | null => {
  const target = toTarget(ref);
  if (!target) {
    return null;
  }

  const suffixMatch = files.find((file) => {
    const filePath = normalize(file.path);
    return filePath === target || filePath.endsWith(`/${target}`);
  });
  if (suffixMatch) {
    return suffixMatch.path;
  }

  const base = target.split('/').pop() || target;
  return files.find((file) => file.name === base)?.path ?? null;
};

/**
 * Wraps an `onFileOpen` handler so a possibly bare/partial file reference is
 * resolved against the project's files before the file is opened in the
 * in-app editor. Only files named like the reference are fetched, through the
 * bounded server search, so this works the same on a project of any size.
 */
export function useFileOpenResolver(
  selectedProject: Project | null | undefined,
  onFileOpen: OnFileOpen,
): OnFileOpen {
  const projectId = selectedProject?.projectId;

  // Both the suffix match and the name fallback need the file name to equal
  // the reference's last segment, so the candidates are exactly the files
  // with that name, in tree order.
  const loadCandidates = useCallback(async (ref: string): Promise<FlatFile[]> => {
    const target = toTarget(ref);
    const base = target.split('/').pop() || target;
    if (!projectId || !base) {
      return [];
    }
    try {
      const response = await api.searchFiles(projectId, {
        q: base,
        match: 'basename',
        filesOnly: true,
        limit: CANDIDATE_LIMIT,
      });
      if (!response.ok) {
        return [];
      }
      return readFileSearchResponse(await response.json()).results
        .map((result) => ({ name: result.name, path: result.path }));
    } catch {
      return [];
    }
  }, [projectId]);

  return useCallback(
    (filePath: string, diffInfo?: any, line?: number | null) => {
      // Normalized once and used for every outcome: a reference picked up from
      // link text can carry surrounding whitespace, which the API would take as
      // part of the filename and answer with a 404.
      const ref = normalize(filePath).trim();
      // An absolute path already names one exact file: matching it against the
      // tree can only send it somewhere else — `/home/user/.config/NOTES.md`
      // used to fall through to the filename match and silently open the
      // project's own `NOTES.md`. A path that exists is unaffected; one that no
      // longer does now reports that instead of opening a same-named file.
      if (isAbsoluteRef(ref)) {
        onFileOpen(ref, diffInfo, line);
        return;
      }
      void loadCandidates(ref).then((files) => {
        const match = findBestMatch(files, ref);
        onFileOpen(match ?? ref, diffInfo, line);
      });
    },
    [loadCandidates, onFileOpen],
  );
}
