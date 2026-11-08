import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import { useProjectSlashCommands } from '@/shared/hooks/useProjectSlashCommands';
import type { Project } from '@/shared/types';

/**
 * TaskMaster hydration and project-list refreshes hand back a new project
 * object with the same path. The slash-command list depends on the path only,
 * so a replaced object must not download the list again.
 */

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

const list = vi.fn(() => okJson({ builtIn: [{ name: '/help' }], custom: [] }));
const skills = vi.fn(() => okJson({ success: true, data: { skills: [] } }));

vi.mock('@/shared/api', () => ({
  api: {
    commands: { list: (...args: unknown[]) => list(...(args as [])) },
    providers: { skills: (...args: unknown[]) => skills(...(args as [])) },
  },
}));

test('a project object replaced with the same path keeps the loaded commands', async () => {
  const project = { projectId: 'p1', fullPath: '/repo', path: '/repo', displayName: 'repo' } as Project;
  const { result, rerender } = renderHook(
    ({ selected }) => useProjectSlashCommands(selected, 'claude'),
    { initialProps: { selected: project } },
  );

  await waitFor(() => assert.equal(result.current.commands.length, 1));
  assert.equal(list.mock.calls.length, 1);
  assert.equal(skills.mock.calls.length, 1, 'skills are asked for alongside the command list');

  rerender({ selected: { ...project, taskmaster: { hasTaskmaster: true } } as Project });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(list.mock.calls.length, 1);

  rerender({ selected: { ...project, fullPath: '/other', path: '/other' } as Project });
  await waitFor(() => assert.equal(list.mock.calls.length, 2));
});
