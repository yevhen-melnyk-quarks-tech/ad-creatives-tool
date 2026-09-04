/**
 * Runs `fn` over `items` with at most `limit` in flight, preserving result order.
 *
 * Deliberately bounded rather than a bare Promise.all: both providers rate-limit, and
 * firing twenty image requests at once trades a slow run for a run that fails.
 *
 * Never rejects. A failing item resolves to `{ ok: false }` so one bad scene cannot
 * abandon the rest — the same guarantee the sequential loops had via try/catch.
 */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };

export async function mapWithConcurrency<In, Out>(
  items: In[],
  limit: number,
  fn: (item: In, index: number) => Promise<Out>
): Promise<Settled<Out>[]> {
  const results: Settled<Out>[] = new Array(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  // Fixed pool of workers pulling from a shared cursor, so a slow item does not hold
  // up a lane the way a chunked approach would.
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (err) {
        results[index] = { ok: false, error: err as Error };
      }
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
