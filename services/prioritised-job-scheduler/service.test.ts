import { PrioritisedJobScheduler, JobExecutor } from './service';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('PrioritisedJobScheduler', () => {
  // TEST 1: Happy path — submit a job, get the executor's result
  it('runs a submitted job and resolves with the executor result', async () => {
    const executor: JobExecutor<number, number> = {
      execute: async (n) => n * 2,
    };
    const scheduler = new PrioritisedJobScheduler(executor, { maxConcurrent: 2 });

    const result = await scheduler.submit(5, 'medium');

    expect(result).toBe(10);
  });

  // TEST 2: Concurrency limit — never more than maxConcurrent active at once
  it('respects the maxConcurrent limit', async () => {
    let active = 0;
    let maxActive = 0;

    const executor: JobExecutor<number, number> = {
      execute: async (n) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
        return n;
      },
    };
    const scheduler = new PrioritisedJobScheduler(executor, { maxConcurrent: 2 });

    await Promise.all([1, 2, 3, 4, 5].map((n) => scheduler.submit(n, 'medium')));

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  // TEST 3: Priority — high jumps ahead of queued lower-priority jobs
  it('runs high-priority jobs before lower-priority ones in the queue', async () => {
    const startOrder: string[] = [];

    const executor: JobExecutor<string, string> = {
      execute: async (name) => {
        startOrder.push(name);
        await delay(20);
        return name;
      },
    };
    const scheduler = new PrioritisedJobScheduler(executor, { maxConcurrent: 1 });

    // A starts immediately (the only slot)
    const a = scheduler.submit('A', 'low');
    // B, C, D queue while A runs
    const b = scheduler.submit('B', 'low');
    const c = scheduler.submit('C', 'high');
    const d = scheduler.submit('D', 'medium');

    await Promise.all([a, b, c, d]);

    // After A: high (C), then medium (D), then low (B)
    expect(startOrder).toEqual(['A', 'C', 'D', 'B']);
  });

  // TEST 4: FIFO within the same priority level
  it('preserves FIFO order within a priority level', async () => {
    const startOrder: string[] = [];

    const executor: JobExecutor<string, string> = {
      execute: async (name) => {
        startOrder.push(name);
        await delay(10);
        return name;
      },
    };
    const scheduler = new PrioritisedJobScheduler(executor, { maxConcurrent: 1 });

    // First one runs immediately; the rest queue in submission order
    await Promise.all([
      scheduler.submit('first', 'low'),
      scheduler.submit('second', 'low'),
      scheduler.submit('third', 'low'),
    ]);

    expect(startOrder).toEqual(['first', 'second', 'third']);
  });

  // TEST 5: Per-job failure — one rejection doesn't kill the others
  it('rejects only the failing submission and keeps running the rest', async () => {
    const executor: JobExecutor<number, number> = {
      execute: async (n) => {
        if (n === 2) throw new Error('job 2 failed');
        return n * 10;
      },
    };
    const scheduler = new PrioritisedJobScheduler(executor, { maxConcurrent: 2 });

    const p1 = scheduler.submit(1, 'medium');
    const p2 = scheduler.submit(2, 'medium');
    const p3 = scheduler.submit(3, 'medium');

    await expect(p1).resolves.toBe(10);
    await expect(p2).rejects.toThrow('job 2 failed');
    await expect(p3).resolves.toBe(30);
  });
});
