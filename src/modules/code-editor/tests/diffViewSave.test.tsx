import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import type * as CodeMirrorMerge from '@codemirror/merge';

import type { CodeEditorFile } from '@/shared/types';

/**
 * Regression guard for saving from the diff view. Clicking an Edit tool card
 * opened the editor with the edit's snippet as the buffer, and saving wrote
 * that snippet over the whole file. The buffer is the file read from disk now;
 * the snippet only shapes the diff, and a file that cannot be read cannot be
 * saved. Also covers keeping a CRLF file CRLF across a save.
 */

type FakeResponse = { ok: boolean; json: () => Promise<unknown> };

const fileResponse = (content: string): FakeResponse => ({ ok: true, json: async () => ({ content }) });
const failedResponse = (error: string): FakeResponse => ({ ok: false, json: async () => ({ success: false, error }) });

const readFile = vi.fn(async (): Promise<FakeResponse> => fileResponse('hello'));
const saveFile = vi.fn(async (_projectId: string, _filePath: string, _content: string) => ({
  ok: true,
  json: async () => ({ success: true }),
}));

vi.mock('@/shared/api', () => ({
  api: { readFile, saveFile },
  readApiJson: async (response: FakeResponse) => {
    const data = await response.json() as { error?: string };
    if (!response.ok) {
      throw new Error(data.error);
    }
    return data;
  },
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

vi.mock('@uiw/react-codemirror', () => {
  function CodeMirrorStub({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
    return (
      <textarea
        data-testid="editor"
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
    );
  }

  return { default: CodeMirrorStub };
});

// The text the diff view compares the buffer against.
const mergeOriginals: string[] = [];

vi.mock('@codemirror/merge', async (importOriginal) => {
  const actual = await importOriginal<typeof CodeMirrorMerge>();
  return {
    ...actual,
    unifiedMergeView: (config: { original: string }) => {
      mergeOriginals.push(config.original);
      return [];
    },
  };
});

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');

const DISK_FILE = 'const a = 1;\nconst b = 20;\nconst c = 3;\n';

const editFile: CodeEditorFile = {
  name: 'a.ts',
  path: '/repo/a.ts',
  projectId: 'p1',
  diffInfo: { old_string: 'const b = 2;', new_string: 'const b = 20;' },
};

const plainFile: CodeEditorFile = { name: 'a.ts', path: '/repo/a.ts', projectId: 'p1' };

beforeEach(() => {
  readFile.mockClear();
  saveFile.mockClear();
  mergeOriginals.length = 0;
});

const openEditor = async (file: CodeEditorFile, expectedBuffer: string) => {
  render(<CodeEditor file={file} onClose={() => undefined} />);
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  await waitFor(() => assert.equal(editor.value, expectedBuffer));
  return editor;
};

const pressSave = () => {
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
};

const savedBody = () => saveFile.mock.calls.at(-1)?.[2];

test('saving from the diff view writes the whole file with the edit, not the snippet', async () => {
  readFile.mockImplementationOnce(async () => fileResponse(DISK_FILE));
  const editor = await openEditor(editFile, DISK_FILE);

  assert.equal(readFile.mock.calls.length, 1, 'the file was read from disk');
  // The diff compares the whole file against the whole file before the edit.
  assert.equal(mergeOriginals.at(-1), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

  fireEvent.change(editor, { target: { value: 'const a = 1;\nconst b = 20;\nconst c = 30;\n' } });
  pressSave();

  await waitFor(() => assert.equal(saveFile.mock.calls.length, 1));
  assert.equal(savedBody(), 'const a = 1;\nconst b = 20;\nconst c = 30;\n');
});

test('a git panel diff that carries the whole file compares against the old file', async () => {
  const oldFile = 'line one\nline two\n';
  const currentFile = 'line one\nline 2\n';
  readFile.mockImplementationOnce(async () => fileResponse(currentFile));

  await openEditor({ ...plainFile, diffInfo: { old_string: oldFile, new_string: currentFile } }, currentFile);

  assert.equal(mergeOriginals.at(-1), oldFile);
});

test('an edit that is no longer in the file shows no diff but still edits the real file', async () => {
  readFile.mockImplementationOnce(async () => fileResponse('rewritten since\n'));
  const editor = await openEditor(editFile, 'rewritten since\n');

  assert.deepEqual(mergeOriginals, []);
  fireEvent.change(editor, { target: { value: 'rewritten since\nmore\n' } });
  pressSave();
  await waitFor(() => assert.equal(saveFile.mock.calls.length, 1));
  assert.equal(savedBody(), 'rewritten since\nmore\n');
});

test('a file that cannot be read cannot be saved, with or without a diff', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  for (const file of [editFile, plainFile]) {
    readFile.mockImplementationOnce(async () => failedResponse('File is too large to open in the editor'));
    const { unmount } = render(<CodeEditor file={file} onClose={() => undefined} />);
    const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
    await waitFor(() => assert.ok(screen.getByText(/read-only and cannot be saved/)));

    fireEvent.change(editor, { target: { value: 'typed into the placeholder' } });
    pressSave();
    fireEvent.click(screen.getByTitle('actions.save'));

    assert.equal(screen.getByTitle('actions.save').hasAttribute('disabled'), true);
    assert.equal(screen.queryByLabelText('Unsaved changes'), null);
    unmount();
  }

  // Let any save that slipped through reach the mock before checking.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saveFile.mock.calls.length, 0);
});

test('a CRLF file is saved with CRLF line endings', async () => {
  readFile.mockImplementationOnce(async () => fileResponse('first\r\nsecond\r\n'));
  // CodeMirror, like this textarea, reports the document with LF.
  const editor = await openEditor(plainFile, 'first\nsecond\n');

  fireEvent.change(editor, { target: { value: 'first\nsecond edited\n' } });
  pressSave();

  await waitFor(() => assert.equal(saveFile.mock.calls.length, 1));
  assert.equal(savedBody(), 'first\r\nsecond edited\r\n');
});

test('an LF file stays LF', async () => {
  readFile.mockImplementationOnce(async () => fileResponse('first\nsecond\n'));
  const editor = await openEditor(plainFile, 'first\nsecond\n');

  fireEvent.change(editor, { target: { value: 'first\nsecond edited\n' } });
  pressSave();

  await waitFor(() => assert.equal(saveFile.mock.calls.length, 1));
  assert.equal(savedBody(), 'first\nsecond edited\n');
});
