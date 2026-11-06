import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { CodeEditorFile } from '@/shared/types';
import { isBinaryFile } from '@/modules/code-editor/utils/binaryFile';
import { getPreviewKind } from '@/modules/code-editor/utils/previewableFile';

type UseCodeEditorDocumentParams = {
  file: CodeEditorFile;
  projectPath?: string;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

// CodeMirror reports its document with LF line endings whatever the file used,
// so a CRLF file would look edited from the first keystroke (and stay "edited"
// after an undo) unless both sides of the comparison are normalised.
const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, '\n');

type LineEnding = '\n' | '\r\n';

// The buffer is kept with LF, so a save has to put back the line ending the
// file had on disk. A file with mixed endings gets the one most lines use.
const detectLineEnding = (text: string): LineEnding => {
  const crlfCount = text.match(/\r\n/g)?.length ?? 0;
  const lfOnlyCount = (text.match(/\n/g)?.length ?? 0) - crlfCount;
  return crlfCount > lfOnlyCount ? '\r\n' : '\n';
};

const applyLineEnding = (text: string, lineEnding: LineEnding) => (
  lineEnding === '\r\n' ? normalizeLineEndings(text).replace(/\n/g, '\r\n') : text
);

/**
 * Rebuilds the file as it was before the edit, so the diff view can compare
 * the whole file on disk against it. A tool card only carries the replaced
 * snippet (`new_string`), the git panel carries the whole file; both are found
 * in the file by searching for `new_string`. Null when the edit can no longer
 * be found there (the file changed since), which shows no diff.
 */
const buildDiffOriginal = (fileText: string, oldString: string, newString: string): string | null => {
  const oldText = normalizeLineEndings(oldString);
  const newText = normalizeLineEndings(newString);
  if (newText === fileText) {
    return oldText;
  }
  const index = newText ? fileText.indexOf(newText) : -1;
  if (index === -1) {
    return null;
  }
  return fileText.slice(0, index) + oldText + fileText.slice(index + newText.length);
};

export const useCodeEditorDocument = ({ file, projectPath }: UseCodeEditorDocumentParams) => {
  const [content, setContent] = useState('');
  // The text as last loaded from disk or written back by a save. The buffer is
  // compared against it to tell whether closing or switching files would
  // discard edits; nothing else in the app knows that baseline.
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  // Set when the file could not be read from disk. The buffer then holds an
  // error text or the diff snippet, never the file, so it must not be saved.
  const [loadError, setLoadError] = useState<string | null>(null);
  // The file as it was before the diff's edit; null when there is no diff.
  const [diffOriginal, setDiffOriginal] = useState<string | null>(null);
  const lineEndingRef = useRef<LineEnding>('\n');
  // Some binaries (images, PDFs, audio, video) can be rendered natively, so the
  // editor shows an inline preview instead of the generic binary placeholder.
  const previewKind = getPreviewKind(file.name);
  // `fileProjectId` is the DB primary key passed down from the editor sidebar;
  // the fallback to `projectPath` preserves older callers that didn't yet
  // propagate the identifier.
  const fileProjectId = file.projectId ?? projectPath;
  const filePath = file.path;
  const fileName = file.name;
  const fileDiffNewString = file.diffInfo?.new_string;
  const fileDiffOldString = file.diffInfo?.old_string;
  // Counts the loads this editor has performed. A read or save still in flight
  // when another file is opened belongs to the previous file and must not land
  // on the new one's buffer, baseline or save state.
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    const loadGeneration = ++loadGenerationRef.current;
    const isStaleLoad = () => loadGenerationRef.current !== loadGeneration;

    // Every load path resets the saved baseline together with the buffer, so a
    // freshly opened file (or an error placeholder) never counts as dirty.
    const applyLoadedContent = (text: string) => {
      setContent(text);
      setSavedContent(text);
    };

    const loadFileContent = async () => {
      try {
        setLoading(true);
        setIsBinary(false);
        setLoadError(null);
        setDiffOriginal(null);
        lineEndingRef.current = '\n';
        // Any save still in flight or failed belongs to the previous file.
        setSaving(false);
        setSaveError(null);

        // Natively previewable media (image/pdf/audio/video) is rendered by
        // CodeEditorMediaPreview, so there is nothing to read as text here.
        // Clear any buffer left over from a previously opened text file so a
        // stray save can't write stale content over the binary file.
        if (getPreviewKind(file.name)) {
          applyLoadedContent('');
          setLoading(false);
          return;
        }

        // Check if file is binary by extension
        if (isBinaryFile(file.name)) {
          applyLoadedContent('');
          setIsBinary(true);
          setLoading(false);
          return;
        }

        if (!fileProjectId) {
          throw new Error('Missing project identifier');
        }

        // Always read the file, also when a diff is attached: a tool card's
        // diff only carries the edited snippet, and saving the buffer writes
        // the whole file.
        const response = await api.readFile(fileProjectId, filePath);
        // Read through readApiJson so the API's own explanation reaches the
        // pane — a directory, a path outside the project root, a missing file.
        // The bare status showed all of those as an opaque "403 Forbidden".
        const data = await readApiJson<{ content: string }>(response);
        if (isStaleLoad()) {
          return;
        }
        lineEndingRef.current = detectLineEnding(data.content);
        const fileText = normalizeLineEndings(data.content);
        applyLoadedContent(fileText);
        if (fileDiffNewString !== undefined && fileDiffOldString !== undefined) {
          setDiffOriginal(buildDiffOriginal(fileText, fileDiffOldString, fileDiffNewString));
        }
      } catch (error) {
        if (isStaleLoad()) {
          return;
        }
        const message = getErrorMessage(error);
        console.error('Error loading file:', error);
        setLoadError(message);
        // A file that cannot be read (deleted, too large) can still show the
        // change that was made to it, read-only.
        if (fileDiffNewString !== undefined && fileDiffOldString !== undefined) {
          applyLoadedContent(normalizeLineEndings(fileDiffNewString));
          setDiffOriginal(normalizeLineEndings(fileDiffOldString));
        } else {
          applyLoadedContent(`// Error loading file: ${message}\n// File: ${fileName}\n// Path: ${filePath}`);
        }
      } finally {
        if (!isStaleLoad()) {
          setLoading(false);
        }
      }
    };

    loadFileContent();
  }, [file.name, fileDiffNewString, fileDiffOldString, fileName, filePath, fileProjectId]);

  // Saving needs the real file in the buffer: not while another file loads
  // (the buffer is still the previous one) and not after a failed read.
  const canSave = !loading && loadError === null && !previewKind && !isBinaryFile(fileName);

  const handleSave = useCallback(async () => {
    // Preview-only and binary files have no editable text buffer; never write
    // them back (e.g. via Cmd/Ctrl+S) or we'd corrupt the file on disk.
    if (!canSave) {
      return;
    }

    const saveGeneration = loadGenerationRef.current;
    const isStaleSave = () => loadGenerationRef.current !== saveGeneration;

    setSaving(true);
    setSaveError(null);

    try {
      if (!fileProjectId) {
        throw new Error('Missing project identifier');
      }

      const response = await api.saveFile(fileProjectId, filePath, applyLineEnding(content, lineEndingRef.current));

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Save failed: ${response.status}`);
        }

        const textError = await response.text();
        console.error('Non-JSON error response:', textError);
        throw new Error(`Save failed: ${response.status} ${response.statusText}`);
      }

      await response.json();

      // Another file loaded while this write was in flight: it owns the buffer,
      // the baseline and the save state now.
      if (isStaleSave()) {
        return;
      }

      // Baseline is the text that was actually sent: anything typed while the
      // request was in flight is still unsaved.
      setSavedContent(content);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Error saving file:', error);
      if (!isStaleSave()) {
        setSaveError(message);
      }
    } finally {
      if (!isStaleSave()) {
        setSaving(false);
      }
    }
  }, [canSave, content, filePath, fileProjectId]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([applyLineEnding(content, lineEndingRef.current)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = file.name;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, [content, file.name]);

  // The baseline only changes on load and save, so it is not re-normalised on
  // every keystroke.
  const normalizedSavedContent = useMemo(() => normalizeLineEndings(savedContent), [savedContent]);

  // Preview and binary files have no editable buffer, and while a file loads
  // the buffer still belongs to the previous one. A file that could not be
  // read has nothing to save. Memoised so renders that do not change the
  // buffer (a save's spinner and tick) skip the comparison.
  const hasUnsavedChanges = useMemo(
    () => (
      !loading
      && !previewKind
      && !isBinary
      && loadError === null
      && content !== savedContent
      && normalizeLineEndings(content) !== normalizedSavedContent
    ),
    [content, isBinary, loadError, loading, normalizedSavedContent, previewKind, savedContent],
  );

  return {
    content,
    setContent,
    loading,
    saving,
    saveSuccess,
    saveError,
    loadError,
    canSave,
    diffOriginal,
    isBinary,
    previewKind,
    fileProjectId,
    hasUnsavedChanges,
    handleSave,
    handleDownload,
  };
};
