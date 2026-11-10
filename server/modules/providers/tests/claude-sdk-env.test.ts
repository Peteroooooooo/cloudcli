import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClaudeSdkEnv } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// Claude Code turns the Artifact tools off for SDK-driven sessions unless
// CLAUDE_CODE_ARTIFACT is set, so a UI session would lose them mid-conversation.
test('SDK sessions opt into the Artifact tools by default', () => {
  assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_ARTIFACT, '1');
});

test('a host CLAUDE_CODE_ARTIFACT value wins over the default', () => {
  assert.equal(buildClaudeSdkEnv({ CLAUDE_CODE_ARTIFACT: '0' }).CLAUDE_CODE_ARTIFACT, '0');
});

// The process registry records this entrypoint, and the running-sessions poll
// leaves out CloudCLI's own turns by it. A server started from a VS Code
// terminal inherits `claude-vscode`, which made its own turns look open in VS
// Code for as long as each process lived.
test('SDK sessions are always labeled claudecodeui, whatever the host inherited', () => {
  assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_ENTRYPOINT, 'claudecodeui');
  assert.equal(buildClaudeSdkEnv({ CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }).CLAUDE_CODE_ENTRYPOINT, 'claudecodeui');
});

test('host env vars are still forwarded', () => {
  assert.equal(buildClaudeSdkEnv({ ANTHROPIC_BASE_URL: 'http://proxy' }).ANTHROPIC_BASE_URL, 'http://proxy');
});
