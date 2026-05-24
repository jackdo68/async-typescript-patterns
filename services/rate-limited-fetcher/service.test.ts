import { RateLimitedFetcher } from './service';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RateLimitedFetcher', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // TEST 1: Happy path — passes URL through to fetch and returns the Response
  it('forwards the URL to globalThis.fetch and returns the response', async () => {
    const fakeResponse = new Response('ok');
    globalThis.fetch = jest.fn(async () => fakeResponse) as typeof globalThis.fetch;

    const fetcher = new RateLimitedFetcher({ maxConcurrent: 1, maxPerSecond: 10 });
    const response = await fetcher.fetch('https://example.com');

    expect(response).toBe(fakeResponse);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://example.com', undefined);
  });

  // TEST 2: Concurrency limit — never more than maxConcurrent in-flight
  it('respects the maxConcurrent limit', async () => {
    let active = 0;
    let maxActive = 0;

    globalThis.fetch = jest.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(30);
      active -= 1;
      return new Response('ok');
    }) as typeof globalThis.fetch;

    const fetcher = new RateLimitedFetcher({ maxConcurrent: 2, maxPerSecond: 100 });
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((u) => fetcher.fetch(`https://example.com/${u}`)),
    );

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  // TEST 3: Per-second limit — never starts more than maxPerSecond inside a 1s window
  it('respects the maxPerSecond limit', async () => {
    const startTimes: number[] = [];

    globalThis.fetch = jest.fn(async () => {
      startTimes.push(Date.now());
      return new Response('ok');
    }) as typeof globalThis.fetch;

    const fetcher = new RateLimitedFetcher({ maxConcurrent: 100, maxPerSecond: 3 });
    const t0 = Date.now();

    await Promise.all(
      Array.from({ length: 5 }, (_, i) => fetcher.fetch(`https://example.com/${i}`)),
    );

    // First 3 should fire ~immediately; remaining 2 must wait until window slides
    const startedInFirstSecond = startTimes.filter((t) => t - t0 < 950).length;
    expect(startedInFirstSecond).toBeLessThanOrEqual(3);
  });

  // TEST 4: Slot released on failure — finally block runs even when fetch rejects
  it('releases the concurrency slot when fetch rejects', async () => {
    let callCount = 0;

    globalThis.fetch = jest.fn(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('network down');
      return new Response('ok');
    }) as typeof globalThis.fetch;

    const fetcher = new RateLimitedFetcher({ maxConcurrent: 1, maxPerSecond: 100 });

    await expect(fetcher.fetch('https://example.com/1')).rejects.toThrow('network down');
    // If the slot weren't released, this second call would hang forever
    const second = await fetcher.fetch('https://example.com/2');
    expect(second).toBeInstanceOf(Response);
    expect(callCount).toBe(2);
  });

  // BONUS: queued requests fire in submission order (FIFO)
  it('serves queued requests in FIFO order', async () => {
    const order: string[] = [];

    globalThis.fetch = jest.fn(async (input) => {
      order.push(input as string);
      await delay(20);
      return new Response('ok');
    }) as typeof globalThis.fetch;

    const fetcher = new RateLimitedFetcher({ maxConcurrent: 1, maxPerSecond: 100 });
    await Promise.all([
      fetcher.fetch('first'),
      fetcher.fetch('second'),
      fetcher.fetch('third'),
    ]);

    expect(order).toEqual(['first', 'second', 'third']);
  });
});
