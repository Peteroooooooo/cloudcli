import assert from 'node:assert/strict';

import { test } from 'vitest';

import { createRenderCache } from '@/modules/chat/utils/renderCache';

/**
 * Rendered markdown and highlighted code are kept by their text, so a session
 * shown again is not parsed again. The cache is bounded and drops what was
 * used longest ago.
 */

test('keeps what was set and returns it by key', () => {
  const cache = createRenderCache<string>(2);
  cache.set('a', 'A');
  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.get('missing'), undefined);
});

test('drops the entry used longest ago once over the limit', () => {
  const cache = createRenderCache<string>(2);
  cache.set('a', 'A');
  cache.set('b', 'B');
  cache.get('a');
  cache.set('c', 'C');

  assert.equal(cache.get('b'), undefined, 'b was the least recently used');
  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.get('c'), 'C');
});
