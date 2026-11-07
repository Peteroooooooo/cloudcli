/**
 * A bounded most-recently-used map for rendered output that depends on its key alone.
 *
 * Used by chat's Markdown and its code blocks: a transcript opened again would
 * otherwise parse every message and re-highlight every code block it showed a
 * moment ago, which is most of the cost of switching back to a long session.
 */
export type RenderCache<V> = {
  get: (key: string) => V | undefined;
  set: (key: string, value: V) => void;
};

export function createRenderCache<V>(limit: number): RenderCache<V> {
  const entries = new Map<string, V>();

  return {
    get(key) {
      const value = entries.get(key);
      if (value !== undefined) {
        // Re-inserted so the Map's insertion order doubles as recency.
        entries.delete(key);
        entries.set(key, value);
      }
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > limit) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
    },
  };
}
