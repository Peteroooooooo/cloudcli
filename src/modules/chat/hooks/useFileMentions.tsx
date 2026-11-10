import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';

import { api } from '@/shared/api';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import type { FileTreeSearchResult, Project } from '@/shared/types';
import { readFileSearchResponse } from '@/shared/utils';

export type MentionableFile = {
  name: string;
  path: string;
  relativePath?: string;
};

type UseFileMentionsOptions = {
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
};

// The dropdown lists this many files, the first matches in tree order.
const MENTION_RESULT_LIMIT = 10;
// Typing pauses this long before the server is asked; each newer query
// aborts the request before it.
const MENTION_SEARCH_DEBOUNCE_MS = 100;

// The `@` query matches a file's name or its project-relative path, the same
// rule the server applies, so earlier results can be narrowed locally while
// the answer for the newer query is on its way.
const matchesMentionQuery = (file: MentionableFile, query: string) => {
  const normalizedQuery = query.toLowerCase();
  return file.name.toLowerCase().includes(normalizedQuery) || file.path.toLowerCase().includes(normalizedQuery);
};

// `path` is what gets inserted into the message (project-relative, `/`
// separated); `relativePath` keeps the absolute path, as before.
const toMentionableFile = (result: FileTreeSearchResult): MentionableFile => ({
  name: result.name,
  path: result.relativePath,
  relativePath: result.path,
});

export function useFileMentions({ selectedProject, input, setInput, textareaRef }: UseFileMentionsOptions) {
  const projectId = selectedProject?.projectId;
  // Server matches for the latest `@` query that has answered. Every query is
  // searched on the server, so files added since the composer opened
  // (uploads, agent edits, the terminal) are always found, in any project size.
  const [searchedFiles, setSearchedFiles] = useState<MentionableFile[]>([]);
  const [fileMentions, setFileMentions] = useState<string[]>([]);
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);
  // The text typed after `@`, or null when the caret is not inside a mention;
  // the server search follows it.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  // The search request still in flight. A newer query or Escape aborts it, so
  // an older response can never overwrite a newer list or re-open a dismissed
  // dropdown.
  const fileSearchRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setSearchedFiles([]);
  }, [projectId]);

  useEffect(() => {
    if (mentionQuery === null || !projectId) {
      return;
    }

    const abortController = new AbortController();
    fileSearchRequestRef.current?.abort();
    fileSearchRequestRef.current = abortController;

    const timer = setTimeout(() => {
      // Escape may have dropped this search before it was sent.
      if (abortController.signal.aborted) {
        return;
      }
      void (async () => {
        try {
          // File search is keyed by DB projectId; the backend resolves it to
          // the project's path before walking it.
          const response = await api.searchFiles(
            projectId,
            { q: mentionQuery, match: 'path', filesOnly: true, limit: MENTION_RESULT_LIMIT },
            { signal: abortController.signal },
          );
          if (!response.ok) {
            return;
          }
          const { results } = readFileSearchResponse(await response.json());
          if (abortController.signal.aborted) {
            return;
          }
          setSearchedFiles(results.map(toMentionableFile));
        } catch (error) {
          // Aborts come from newer queries, Escape and project switches.
          if ((error as { name?: string })?.name === 'AbortError') {
            return;
          }
          console.error('Error searching files:', error);
        }
      })();
    }, MENTION_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      abortController.abort();
    };
  }, [mentionQuery, projectId]);

  useEffect(() => {
    const textBeforeCursor = input.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      setMentionQuery(null);
      return;
    }

    const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
    if (textAfterAt.includes(' ')) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      setMentionQuery(null);
      return;
    }

    setAtSymbolPosition(lastAtIndex);
    setShowFileDropdown(true);
    setSelectedFileIndex(-1);
    setMentionQuery(textAfterAt);
  }, [input, cursorPosition]);

  // Until the server answers the newest query, the previous answer narrowed
  // to the newest query stays visible, so the list never shows a file that
  // does not match what is typed.
  const filteredFiles = useMemo(() => {
    if (mentionQuery === null) {
      return [];
    }
    return searchedFiles.filter((file) => matchesMentionQuery(file, mentionQuery)).slice(0, MENTION_RESULT_LIMIT);
  }, [mentionQuery, searchedFiles]);

  const activeFileMentions = useMemo(() => {
    if (!input || fileMentions.length === 0) {
      return [];
    }
    return fileMentions.filter((path) => input.includes(path));
  }, [fileMentions, input]);

  const sortedFileMentions = useMemo(() => {
    if (activeFileMentions.length === 0) {
      return [];
    }
    const uniqueMentions = Array.from(new Set(activeFileMentions));
    return uniqueMentions.sort((mentionA, mentionB) => mentionB.length - mentionA.length);
  }, [activeFileMentions]);

  const fileMentionRegex = useMemo(() => {
    if (sortedFileMentions.length === 0) {
      return null;
    }
    const pattern = sortedFileMentions.map(escapeRegExp).join('|');
    return new RegExp(`(${pattern})`, 'g');
  }, [sortedFileMentions]);

  const fileMentionSet = useMemo(() => new Set(sortedFileMentions), [sortedFileMentions]);

  const renderInputWithMentions = useCallback(
    (text: string) => {
      if (!text) {
        return '';
      }
      if (!fileMentionRegex) {
        return text;
      }

      const parts = text.split(fileMentionRegex);
      return parts.map((part, index) =>
        fileMentionSet.has(part) ? (
          <span
            key={`mention-${index}`}
            className="-ml-0.5 rounded-md bg-blue-200/70 box-decoration-clone px-0.5 text-transparent dark:bg-blue-300/40"
          >
            {part}
          </span>
        ) : (
          <span key={`text-${index}`}>{part}</span>
        ),
      );
    },
    [fileMentionRegex, fileMentionSet],
  );

  const selectFile = useCallback(
    (file: MentionableFile) => {
      const textBeforeAt = input.slice(0, atSymbolPosition);
      const textAfterAtQuery = input.slice(atSymbolPosition);
      const spaceIndex = textAfterAtQuery.indexOf(' ');
      const textAfterQuery = spaceIndex !== -1 ? textAfterAtQuery.slice(spaceIndex) : '';

      const newInput = `${textBeforeAt}${file.path} ${textAfterQuery}`;
      const newCursorPosition = textBeforeAt.length + file.path.length + 1;

      if (textareaRef.current && !textareaRef.current.matches(':focus')) {
        textareaRef.current.focus();
      }

      setInput(newInput);
      setCursorPosition(newCursorPosition);
      setFileMentions((previousMentions) =>
        previousMentions.includes(file.path) ? previousMentions : [...previousMentions, file.path],
      );

      setShowFileDropdown(false);
      setAtSymbolPosition(-1);

      if (!textareaRef.current) {
        return;
      }

      requestAnimationFrame(() => {
        if (!textareaRef.current) {
          return;
        }
        textareaRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        if (!textareaRef.current.matches(':focus')) {
          textareaRef.current.focus();
        }
      });
    },
    [input, atSymbolPosition, textareaRef, setInput],
  );

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileDropdown) {
        return false;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        // Results never re-open a dismissed dropdown (only typing does), so
        // the search in flight is no longer needed. Drop it; typing on inside
        // the query searches again.
        fileSearchRequestRef.current?.abort();
        setShowFileDropdown(false);
        return true;
      }

      if (filteredFiles.length === 0) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex < filteredFiles.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : filteredFiles.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        if (selectedFileIndex >= 0) {
          selectFile(filteredFiles[selectedFileIndex]);
        } else if (filteredFiles.length > 0) {
          selectFile(filteredFiles[0]);
        }
        return true;
      }

      return false;
    },
    [showFileDropdown, filteredFiles, selectedFileIndex, selectFile],
  );

  return {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  };
}
