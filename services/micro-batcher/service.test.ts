import { MicroBatcher } from './service';

describe('MicroBatcher', () => {
  // TEST 1: Happy path — does it batch and return correct results?
  it('batches items and returns individual results', async () => {
    const batchFn = jest.fn(async (items: number[]) => items.map((x) => x * 2));
    const batcher = new MicroBatcher(batchFn, { maxBatchSize: 3, maxWaitMs: 1000 });

    const results = await Promise.all([
      batcher.submit(1),
      batcher.submit(2),
      batcher.submit(3),
    ]);

    expect(results).toEqual([2, 4, 6]);
    expect(batchFn).toHaveBeenCalledTimes(1);          // ONE batch call, not three
    expect(batchFn).toHaveBeenCalledWith([1, 2, 3]);   // correct items
  });

  // TEST 2: Error case — batchFn throws, all callers in the batch are rejected
  it('rejects all callers when batchFn fails', async () => {
    const batchFn = jest.fn(async () => {
      throw new Error('boom');
    });
    const batcher = new MicroBatcher(batchFn, { maxBatchSize: 2, maxWaitMs: 1000 });

    const p1 = batcher.submit(1);
    const p2 = batcher.submit(2);

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');
  });

  // TEST 3: Timer flush — batch fires before reaching maxBatchSize
  it('flushes on timer when batch is not full', async () => {
    const batchFn = jest.fn(async (items: number[]) => items.map((x) => x * 2));
    const batcher = new MicroBatcher(batchFn, { maxBatchSize: 100, maxWaitMs: 50 });

    const result = await batcher.submit(1);  // only 1 item, has to wait for the timer

    expect(result).toBe(2);
    expect(batchFn).toHaveBeenCalledTimes(1);
  });

  // TEST 4: per-item Error in batchFn result rejects only that caller
  it('resolves and rejects per-item based on Error in result array', async () => {
    const batchFn = jest.fn(async (items: number[]) =>
      items.map((x) => (x === 2 ? new Error('item 2 failed') : x * 2)),
    );
    const batcher = new MicroBatcher(batchFn, { maxBatchSize: 3, maxWaitMs: 1000 });

    const p1 = batcher.submit(1);
    const p2 = batcher.submit(2);
    const p3 = batcher.submit(3);

    await expect(p1).resolves.toBe(2);
    await expect(p2).rejects.toThrow('item 2 failed');
    await expect(p3).resolves.toBe(6);
    expect(batchFn).toHaveBeenCalledTimes(1);
  });

  // BONUS: shutdown drains queued items and rejects new submits
  it('flushes remaining items on shutdown and rejects new submits', async () => {
    const batchFn = jest.fn(async (items: number[]) => items.map((x) => x * 2));
    const batcher = new MicroBatcher(batchFn, { maxBatchSize: 10, maxWaitMs: 5000 });

    const p1 =  batcher.submit(1);
    const p2 =  batcher.submit(2);

    await batcher.shutdown();

    await expect(p1).resolves.toBe(2);
    await expect(p2).resolves.toBe(4);
    expect(batchFn).toHaveBeenCalledTimes(1);

    await expect(batcher.submit(3)).rejects.toThrow('shut down');
  });
});
