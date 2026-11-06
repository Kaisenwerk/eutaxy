/**
 * Independent jobs run a few at a time, with their results in the order of
 * the items whatever order the jobs finish in: what an engine needs to run
 * one solver process per property, or the report one process per module,
 * without the answer depending on which finished first. A job that throws
 * rejects the pool, and no job is started after it.
 */

/** `work` on every item, at most `limit` at once; the results in item order. */
export async function inPool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  // Once a job has thrown, the pool's answer is that error: no further job is started.
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        results[i] = await work(items[i] as T, i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
