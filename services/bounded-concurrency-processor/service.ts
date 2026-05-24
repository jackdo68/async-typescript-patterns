export interface ProcessResult<R> {
  status: 'fulfilled' | 'rejected';
  value?: R;
  error?: Error;
}

export async function processWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<ProcessResult<R>[]> {
  const results: ProcessResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;

      try {
        const value = await fn(items[index]!);
        results[index] = { status: 'fulfilled', value };
      } catch (error) {
        results[index] = {
          status: 'rejected',
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return results;
}
