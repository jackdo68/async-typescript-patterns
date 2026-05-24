# Pair Coding Interview Prep — Async Patterns in TypeScript

> **Typical format:** 60-minute pair coding session with one or two interviewers (often a Lead Engineer + Engineering Manager). Problem usually sent ~1 hour before. You drive in your own IDE. TypeScript allowed. Unit tests expected.

---

## What Interviewers Look For

- Your **thought process** and how you break down the problem
- Communication and collaboration (you're pair coding, not solo)
- Clean, readable code with good structure
- Unit tests
- Concurrency understanding
- Error handling

## Common Problem Themes

These patterns come up repeatedly in pair-coding interviews for backend/full-stack roles:

- **Micro-batching** — collect many individual calls into one bulk operation
- **Bounded concurrency** — process a stream of work with a max number in-flight
- **Rate limiting** — keep request rate within a budget
- **Retries / circuit breakers** — resilience when calling unreliable systems
- **Caching with TTL + thundering-herd protection**
- **Race conditions** in async JavaScript and how to avoid them

---

## Scenario 1: Micro-Batching Library

### Question

You're building a service that receives many individual requests (e.g. domain scans, user lookups, API calls). Instead of processing each one individually, you want to collect them into batches and process them together for efficiency.

Implement a `MicroBatcher` that:
- Accepts individual items via `submit()`, each caller gets a Promise for their result
- Collects items into a batch
- Flushes the batch when it reaches `maxBatchSize` OR when `maxWaitMs` has elapsed (whichever comes first)
- Calls a `batchFn` to process the entire batch at once
- Maps results back to individual callers

```typescript
type BatchFn<T, R> = (items: T[]) => Promise<R[]>;

interface MicroBatcherOptions {
  maxBatchSize: number;
  maxWaitMs: number;
}

class MicroBatcher<T, R> {
  constructor(batchFn: BatchFn<T, R>, options: MicroBatcherOptions) {}

  // Individual callers use this — returns a promise for THEIR specific result
  submit(item: T): Promise<R> {}

  // Flush remaining items and stop accepting new ones
  shutdown(): Promise<void> {}
}

// Example usage:
// const batcher = new MicroBatcher(
//   async (urls: string[]) => scanAll(urls),  // processes a whole batch at once
//   { maxBatchSize: 10, maxWaitMs: 100 }
// );
//
// // These 3 individual calls get batched into ONE call to batchFn
// const r1 = batcher.submit("example.com");
// const r2 = batcher.submit("test.com");
// const r3 = batcher.submit("foo.com");
//
// // Each caller still gets their own result
// const results = await Promise.all([r1, r2, r3]);
```

### Answer

**Key insight:** Each `submit()` creates a Promise but does NOT call `batchFn` immediately. Instead, store the item along with its `resolve`/`reject` callbacks. When the batch triggers (size or timer), call `batchFn` once and map results back to each caller.

```typescript
type BatchFn<T, R> = (items: T[]) => Promise<R[]>;

interface MicroBatcherOptions {
  maxBatchSize: number;
  maxWaitMs: number;
}

interface QueueEntry<T, R> {
  item: T;
  resolve: (value: R) => void;
  reject: (error: Error) => void;
}

class MicroBatcher<T, R> {
  private queue: QueueEntry<T, R>[] = [];
  private timer: NodeJS.Timeout | null = null;
  private batchFn: BatchFn<T, R>;
  private maxBatchSize: number;
  private maxWaitMs: number;
  private isShutdown = false;

  constructor(batchFn: BatchFn<T, R>, options: MicroBatcherOptions) {
    this.batchFn = batchFn;
    this.maxBatchSize = options.maxBatchSize;
    this.maxWaitMs = options.maxWaitMs;
  }

  submit(item: T): Promise<R> {
    if (this.isShutdown) {
      return Promise.reject(new Error('MicroBatcher has been shut down'));
    }

    return new Promise<R>((resolve, reject) => {
      this.queue.push({ item, resolve, reject });

      if (this.queue.length >= this.maxBatchSize) {
        // Batch is full — flush immediately
        this.flush();
      } else if (!this.timer) {
        // Start the timer on first item in a new batch
        this.timer = setTimeout(() => this.flush(), this.maxWaitMs);
      }
    });
  }

  private async flush(): Promise<void> {
    // Clear the timer
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) return;

    // Take the current batch out of the queue
    const batch = this.queue.splice(0, this.maxBatchSize);
    const items = batch.map((entry) => entry.item);

    try {
      const results = await this.batchFn(items);

      // Map each result back to its caller
      batch.forEach((entry, index) => {
        if (index < results.length) {
          entry.resolve(results[index]!);
        } else {
          entry.reject(new Error('Batch function returned fewer results than items'));
        }
      });
    } catch (error) {
      // Reject ALL promises in this batch
      batch.forEach((entry) => {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      });
    }

    // If there are leftover items (queue > maxBatchSize), flush again
    if (this.queue.length > 0) {
      this.flush();
    }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    await this.flush();
  }
}
```

**Algorithm:** Producer-consumer with deferred resolution. The `new Promise` constructor captures `resolve`/`reject`, stores them in the queue, and the batch flush resolves them later. Two triggers: size threshold and timer.

**Complexity:** O(1) per submit, O(n) per flush where n = batch size. Space O(n) for queued items.

**Edge cases to discuss:**
- `batchFn` returns fewer results than items submitted — index mismatch
- `batchFn` throws — all callers in that batch should be rejected
- `submit()` called after `shutdown()` — should reject immediately
- Timer fires while a previous batch is still processing — safe because we splice the batch out
- Items arrive faster than batches can process — discuss backpressure
- `maxBatchSize` of 1 — degrades to individual processing (still correct)
- `maxWaitMs` of 0 — should flush immediately on every submit

**Tests:**

```typescript
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('MicroBatcher', () => {
  it('batches items up to maxBatchSize', async () => {
    const batchFn = jest.fn(async (items: number[]) => items.map((x) => x * 2));
    const batcher = new MicroBatcher(batchFn, { maxBatchSize: 3, maxWaitMs: 1000 });

    const results = await Promise.all([
      batcher.submit(1),
      batcher.submit(2),
      batcher.submit(3),
    ]);

    expect(results).toEqual([2, 4, 6]);
    expect(batchFn).toHaveBeenCalledTimes(1); // ONE call, not three
    expect(batchFn).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('flushes on timer when batch is not full', async () => {
    const batchFn = jest.fn(async (items: number[]) => items.map((x) => x * 2));
    const batcher = new MicroBatcher(batchFn, { maxBatchSize: 10, maxWaitMs: 50 });

    const result = await batcher.submit(1);

    expect(result).toBe(2);
    expect(batchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects all callers if batchFn fails', async () => {
    const batchFn = jest.fn(async () => {
      throw new Error('boom');
    });
    const batcher = new MicroBatcher(batchFn, { maxBatchSize: 2, maxWaitMs: 1000 });

    const p1 = batcher.submit(1);
    const p2 = batcher.submit(2);

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');
  });

  it('rejects submit after shutdown', async () => {
    const batchFn = jest.fn(async (items: number[]) => items);
    const batcher = new MicroBatcher(batchFn, { maxBatchSize: 10, maxWaitMs: 1000 });

    await batcher.shutdown();

    await expect(batcher.submit(1)).rejects.toThrow('shut down');
  });

  it('flushes remaining items on shutdown', async () => {
    const batchFn = jest.fn(async (items: number[]) => items.map((x) => x * 2));
    const batcher = new MicroBatcher(batchFn, { maxBatchSize: 10, maxWaitMs: 5000 });

    const p1 = batcher.submit(1);
    const p2 = batcher.submit(2);

    await batcher.shutdown();

    expect(await p1).toBe(2);
    expect(await p2).toBe(4);
    expect(batchFn).toHaveBeenCalledTimes(1);
  });

  it('handles multiple batches when items exceed maxBatchSize', async () => {
    const batchFn = jest.fn(async (items: number[]) => items.map((x) => x * 2));
    const batcher = new MicroBatcher(batchFn, { maxBatchSize: 2, maxWaitMs: 1000 });

    const results = await Promise.all([
      batcher.submit(1),
      batcher.submit(2),
      batcher.submit(3),
      batcher.submit(4),
    ]);

    expect(results).toEqual([2, 4, 6, 8]);
    expect(batchFn).toHaveBeenCalledTimes(2); // Two batches of 2
  });
});
```

**Part 2 discussion / follow-ups they may ask:**
- Add a concurrency limit — only N batches processing at a time
- Add retry logic for failed batches
- Add per-item timeout
- Add metrics/observability (batch size histogram, latency, failure rate)
- What would change if this ran in a distributed system?

---

## Scenario 2: Bounded Concurrency Processor

### Question

Implement a function that processes an array of items concurrently, but limits the number of in-flight operations to `concurrency`. Return all results in the original order. If individual items fail, capture the error without killing the whole batch.

```typescript
interface ProcessResult<R> {
  status: 'fulfilled' | 'rejected';
  value?: R;
  error?: Error;
}

async function processWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<ProcessResult<R>[]> {}

// Example:
// const results = await processWithConcurrency(
//   ['url1', 'url2', 'url3', 'url4', 'url5'],
//   scanUrl,
//   2  // max 2 in-flight at a time
// );
```

### Answer

**Algorithm:** Worker pool — spin up N workers that pull from a shared index counter. Each worker loops until all items are consumed.

```typescript
interface ProcessResult<R> {
  status: 'fulfilled' | 'rejected';
  value?: R;
  error?: Error;
}

async function processWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<ProcessResult<R>[]> {
  const results: ProcessResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;

      try {
        const value = await fn(items[index]);
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
```

**Complexity:** O(n) total work, max `concurrency` in-flight at once. Space O(n) for results.

**Edge cases to discuss:**
- Empty items array — should return []
- Concurrency greater than items length — don't spin up more workers than items
- One item fails — others should still complete
- All items fail — still returns all results with error info
- `fn` hangs forever on one item — blocks that worker (discuss adding timeout)

**Tests:**

```typescript
describe('processWithConcurrency', () => {
  it('processes all items and preserves order', async () => {
    const fn = async (x: number) => x * 2;
    const results = await processWithConcurrency([1, 2, 3], fn, 2);

    expect(results).toEqual([
      { status: 'fulfilled', value: 2 },
      { status: 'fulfilled', value: 4 },
      { status: 'fulfilled', value: 6 },
    ]);
  });

  it('respects concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;

    const fn = async (x: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 50));
      active--;
      return x;
    };

    await processWithConcurrency([1, 2, 3, 4, 5], fn, 2);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('captures individual failures without killing the batch', async () => {
    const fn = async (x: number) => {
      if (x === 2) throw new Error('fail');
      return x * 2;
    };

    const results = await processWithConcurrency([1, 2, 3], fn, 3);

    expect(results[0]).toEqual({ status: 'fulfilled', value: 2 });
    expect(results[1].status).toBe('rejected');
    expect(results[1].error?.message).toBe('fail');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 6 });
  });

  it('handles empty input', async () => {
    const fn = async (x: number) => x;
    const results = await processWithConcurrency([], fn, 5);
    expect(results).toEqual([]);
  });
});
```

---

## Scenario 3: Rate-Limited Fetcher

### Question

Implement a `RateLimitedFetcher` that makes HTTP requests but limits to `maxConcurrent` in-flight requests AND `maxPerSecond` requests per second. If the limits are hit, requests should queue and wait.

```typescript
class RateLimitedFetcher {
  constructor(options: { maxConcurrent: number; maxPerSecond: number }) {}

  // Queues the request if limits are hit, resolves when it completes
  async fetch(url: string): Promise<Response> {}
}

// Example:
// const fetcher = new RateLimitedFetcher({ maxConcurrent: 5, maxPerSecond: 10 });
// const results = await Promise.all(urls.map(url => fetcher.fetch(url)));
```

### Answer

**Algorithm:** Combines bounded concurrency (semaphore) with a sliding window rate limiter (token bucket).

```typescript
class RateLimitedFetcher {
  private maxConcurrent: number;
  private maxPerSecond: number;
  private activeConcurrent = 0;
  private timestamps: number[] = [];
  private queue: Array<() => void> = [];

  constructor(options: { maxConcurrent: number; maxPerSecond: number }) {
    this.maxConcurrent = options.maxConcurrent;
    this.maxPerSecond = options.maxPerSecond;
  }

  async fetch(url: string): Promise<Response> {
    await this.acquireSlot();

    try {
      const response = await globalThis.fetch(url);
      return response;
    } finally {
      this.activeConcurrent--;
      this.processQueue();
    }
  }

  private acquireSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      const tryAcquire = () => {
        // Clean up old timestamps
        const now = Date.now();
        this.timestamps = this.timestamps.filter((t) => t > now - 1000);

        if (
          this.activeConcurrent < this.maxConcurrent &&
          this.timestamps.length < this.maxPerSecond
        ) {
          this.activeConcurrent++;
          this.timestamps.push(now);
          resolve();
        } else {
          // Queue this request
          this.queue.push(tryAcquire);
        }
      };

      tryAcquire();
    });
  }

  private processQueue(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      // Small delay to allow rate limit window to slide
      setTimeout(next, 0);
    }
  }
}
```

**Edge cases to discuss:**
- Rate limit window reset timing — requests at boundary of the 1-second window
- Request fails — should still release the concurrency slot (finally block)
- Queue grows unbounded — discuss backpressure or max queue size
- Starvation — oldest requests should be served first (FIFO)

---

## Scenario 4: Concurrent Scanner with Result Aggregation

### Question

You're building a service that runs multiple independent checks on a target concurrently (e.g. TLS, DNS, open ports, HTTP headers on a domain). Each check may succeed or fail independently. Aggregate all results into a single report. If one check fails, the others should still complete.

```typescript
type CheckName = string;
type CheckFn = (domain: string) => Promise<any>;
type CheckResult = {
  status: 'passed' | 'error';
  data?: any;
  error?: string;
};
type ScanReport = {
  domain: string;
  results: Record<CheckName, CheckResult>;
  scannedAt: Date;
};

class DomainScanner {
  constructor(checks: Record<CheckName, CheckFn>, options?: { timeoutMs?: number }) {}

  // Runs all checks concurrently, returns aggregated report
  async scan(domain: string): Promise<ScanReport> {}
}

// Example usage:
// const scanner = new DomainScanner({
//   tls: checkTLS,
//   dns: checkDNS,
//   ports: checkPorts,
//   headers: checkHeaders,
// }, { timeoutMs: 5000 });
//
// const report = await scanner.scan("example.com");
// report.results.tls    → { status: 'passed', data: { version: 'TLSv1.3' } }
// report.results.dns    → { status: 'passed', data: { hasDNSSEC: true } }
// report.results.ports  → { status: 'error', error: 'Connection timeout' }
// report.results.headers → { status: 'passed', data: { hasHSTS: true } }
```

### Answer

**Algorithm:** Run all checks with `Promise.allSettled` so no single failure kills the scan. Wrap each check with a timeout using `Promise.race`. Aggregate results into a structured report.

```typescript
type CheckName = string;
type CheckFn = (domain: string) => Promise<any>;
type CheckResult = {
  status: 'passed' | 'error';
  data?: any;
  error?: string;
};
type ScanReport = {
  domain: string;
  results: Record<CheckName, CheckResult>;
  scannedAt: Date;
};

class DomainScanner {
  private checks: Record<CheckName, CheckFn>;
  private timeoutMs: number;

  constructor(
    checks: Record<CheckName, CheckFn>,
    options: { timeoutMs?: number } = {}
  ) {
    this.checks = checks;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  async scan(domain: string): Promise<ScanReport> {
    const checkNames = Object.keys(this.checks);

    const promises = checkNames.map((name) =>
      this.runCheck(name, domain)
    );

    const settled = await Promise.allSettled(promises);

    const results: Record<CheckName, CheckResult> = {};

    settled.forEach((outcome, index) => {
      const name = checkNames[index];

      if (outcome.status === 'fulfilled') {
        results[name] = { status: 'passed', data: outcome.value };
      } else {
        results[name] = {
          status: 'error',
          error: outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
        };
      }
    });

    return {
      domain,
      results,
      scannedAt: new Date(),
    };
  }

  // Throws on timeout or check failure — scan() catches via Promise.allSettled
  private async runCheck(name: string, domain: string): Promise<any> {
    const checkFn = this.checks[name];

    let timeoutId: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Check "${name}" timed out`)),
        this.timeoutMs
      );
    });

    try {
      return await Promise.race([checkFn(domain), timeout]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }
}
```

**Complexity:** O(1) setup, all checks run concurrently. Total time = slowest check (or timeout). Space O(k) where k = number of checks.

**Edge cases to discuss:**
- One check hangs forever — timeout ensures it doesn't block the report
- All checks fail — still returns a valid report with all errors
- Empty checks object — returns empty results
- Check returns `null` or `undefined` — still a valid "passed" result
- Same scanner used for multiple domains concurrently — stateless, so safe

**Tests:**

```typescript
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('DomainScanner', () => {
  it('runs all checks and aggregates results', async () => {
    const scanner = new DomainScanner({
      tls: async () => ({ version: 'TLSv1.3' }),
      dns: async () => ({ hasDNSSEC: true }),
    });

    const report = await scanner.scan('example.com');

    expect(report.domain).toBe('example.com');
    expect(report.results.tls).toEqual({ status: 'passed', data: { version: 'TLSv1.3' } });
    expect(report.results.dns).toEqual({ status: 'passed', data: { hasDNSSEC: true } });
  });

  it('captures individual check failures without killing the scan', async () => {
    const scanner = new DomainScanner({
      tls: async () => ({ version: 'TLSv1.3' }),
      dns: async () => { throw new Error('DNS lookup failed'); },
    });

    const report = await scanner.scan('example.com');

    expect(report.results.tls.status).toBe('passed');
    expect(report.results.dns.status).toBe('error');
    expect(report.results.dns.error).toBe('DNS lookup failed');
  });

  it('times out slow checks', async () => {
    const scanner = new DomainScanner({
      fast: async () => 'done',
      slow: async () => { await delay(5000); return 'late'; },
    }, { timeoutMs: 50 });

    const report = await scanner.scan('example.com');

    expect(report.results.fast.status).toBe('passed');
    expect(report.results.slow.status).toBe('error');
    expect(report.results.slow.error).toContain('timed out');
  });
});
```

**Part 2 discussion / follow-ups:**
- Add retry for failed checks (combine with retry/backoff pattern)
- Priority ordering — run critical checks first
- Caching — don't re-scan the same domain within a TTL window (combine with Scenario 5)
- Combine with micro-batching — scan many domains at once, each with multiple checks

---

## Scenario 5: Cache with TTL

### Question

You're building a cache for expensive computed values. Each entry should automatically expire after a configurable time-to-live (TTL). The cache should also handle the "thundering herd" problem — if multiple requests arrive for the same key while it's being fetched, they should all wait for the single in-flight fetch rather than triggering duplicate fetches.

```typescript
type FetchFn<T> = (key: string) => Promise<T>;

class TTLCache<T> {
  constructor(fetchFn: FetchFn<T>, options: { ttlMs: number }) {}

  // Get a value — returns from cache if fresh, otherwise fetches
  async get(key: string): Promise<T> {}

  // Manually invalidate a key
  invalidate(key: string): void {}

  // Clear the entire cache
  clear(): void {}
}

// Example usage:
// const cache = new TTLCache(
//   async (key) => expensiveFetch(key),  // expensive fetch function
//   { ttlMs: 60000 }                     // cache for 1 minute
// );
//
// const result1 = await cache.get("foo");  // fetches, caches
// const result2 = await cache.get("foo");  // returns cached (no fetch)
// // ... 60 seconds pass ...
// const result3 = await cache.get("foo");  // expired, fetches again
```

### Answer

**Algorithm:** Store entries with their expiration timestamp. On `get()`, check if the entry is still valid. The key trick is **request deduplication** — store the in-flight Promise (not just the result) so concurrent requests for the same key share a single fetch.

```typescript
type FetchFn<T> = (key: string) => Promise<T>;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private inFlight = new Map<string, Promise<T>>();
  private fetchFn: FetchFn<T>;
  private ttlMs: number;

  constructor(fetchFn: FetchFn<T>, options: { ttlMs: number }) {
    this.fetchFn = fetchFn;
    this.ttlMs = options.ttlMs;
  }

  async get(key: string): Promise<T> {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Check if there's already an in-flight request for this key
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key)!;
    }

    // Fetch, store the promise to deduplicate concurrent requests
    const fetchPromise = this.fetchAndCache(key);
    this.inFlight.set(key, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  private async fetchAndCache(key: string): Promise<T> {
    const value = await this.fetchFn(key);

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });

    return value;
  }
}
```

**Algorithm:** Map-based cache with timestamp expiry + in-flight Promise deduplication. The `inFlight` map is the key insight — it prevents the thundering herd by sharing a single Promise across concurrent callers.

**Complexity:** O(1) get/set. Space O(n) cached entries + O(k) in-flight requests.

**Edge cases to discuss:**
- Thundering herd — 100 requests for the same key at once → only 1 fetch (the `inFlight` map handles this)
- Fetch fails — the error propagates to ALL waiters, and nothing is cached
- Stale-while-revalidate — serve stale data while fetching fresh (discuss as extension)
- Memory growth — entries never cleaned up unless accessed or invalidated. Could add periodic cleanup
- TTL of 0 — always fetches, still deduplicates concurrent requests
- `invalidate()` called while an in-flight fetch is happening — should it cancel the fetch?

**Tests:**

```typescript
describe('TTLCache', () => {
  it('caches the result and returns it on subsequent calls', async () => {
    const fetchFn = jest.fn(async (key: string) => `result-${key}`);
    const cache = new TTLCache(fetchFn, { ttlMs: 1000 });

    const r1 = await cache.get('a');
    const r2 = await cache.get('a');

    expect(r1).toBe('result-a');
    expect(r2).toBe('result-a');
    expect(fetchFn).toHaveBeenCalledTimes(1); // only ONE fetch
  });

  it('re-fetches after TTL expires', async () => {
    const fetchFn = jest.fn(async () => 'data');
    const cache = new TTLCache(fetchFn, { ttlMs: 50 });

    await cache.get('a');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 60)); // wait for expiry

    await cache.get('a');
    expect(fetchFn).toHaveBeenCalledTimes(2); // fetched again
  });

  it('deduplicates concurrent requests for the same key', async () => {
    const fetchFn = jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 'data';
    });
    const cache = new TTLCache(fetchFn, { ttlMs: 1000 });

    // Fire 5 concurrent requests for the same key
    const results = await Promise.all([
      cache.get('a'),
      cache.get('a'),
      cache.get('a'),
      cache.get('a'),
      cache.get('a'),
    ]);

    expect(results).toEqual(['data', 'data', 'data', 'data', 'data']);
    expect(fetchFn).toHaveBeenCalledTimes(1); // only ONE fetch, not 5
  });
});
```

**Part 2 discussion / follow-ups:**
- Stale-while-revalidate: return cached value immediately, fetch in background
- LRU eviction: limit cache size, evict least-recently-used entries
- Periodic cleanup: setInterval to sweep expired entries
- Distributed cache: Redis-backed instead of in-memory

---

## Scenario 6: Retry with Circuit Breaker

### Question

You're calling external endpoints that may be unreliable. Implement a `CircuitBreaker` that wraps an async function and prevents calling it when it's known to be failing. Three states:
- **Closed** (normal): requests pass through. Track failures.
- **Open** (broken): reject immediately without calling the function. After a cooldown, transition to half-open.
- **Half-Open** (testing): allow ONE request through. If it succeeds → closed. If it fails → open again.

```typescript
interface CircuitBreakerOptions {
  failureThreshold: number;  // failures before opening
  cooldownMs: number;        // how long to stay open before testing
}

class CircuitBreaker<T> {
  constructor(fn: () => Promise<T>, options: CircuitBreakerOptions) {}

  // Execute the wrapped function (or reject if circuit is open)
  async execute(): Promise<T> {}

  // Get current state for monitoring
  getState(): 'closed' | 'open' | 'half-open' {}
}

// Example usage:
// const breaker = new CircuitBreaker(
//   () => fetch('https://api.example.com/scan'),
//   { failureThreshold: 3, cooldownMs: 10000 }
// );
//
// await breaker.execute();  // passes through (closed)
// // ... 3 failures in a row ...
// await breaker.execute();  // throws immediately (open) — doesn't even call the API
// // ... 10 seconds pass ...
// await breaker.execute();  // allows one test request (half-open)
```

### Answer

**Algorithm:** State machine with 3 states. Track consecutive failure count. Transition: closed → open when failures hit threshold. Open → half-open after cooldown. Half-open → closed on success, back to open on failure.

```typescript
interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
}

type CircuitState = 'closed' | 'open' | 'half-open';

class CircuitBreaker<T> {
  private fn: () => Promise<T>;
  private failureThreshold: number;
  private cooldownMs: number;

  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private halfOpenInFlight = false;

  constructor(fn: () => Promise<T>, options: CircuitBreakerOptions) {
    this.fn = fn;
    this.failureThreshold = options.failureThreshold;
    this.cooldownMs = options.cooldownMs;
  }

  async execute(): Promise<T> {
    if (this.state === 'open') {
      // Check if cooldown has elapsed
      if (this.lastFailureTime && Date.now() - this.lastFailureTime >= this.cooldownMs) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open — request rejected');
      }
    }

    // Half-open: only allow ONE test request through
    if (this.state === 'half-open') {
      if (this.halfOpenInFlight) {
        throw new Error('Circuit breaker is half-open — test request already in flight');
      }
      this.halfOpenInFlight = true;
    }

    try {
      const result = await this.fn();

      // Success — reset to closed
      this.state = 'closed';
      this.failureCount = 0;
      this.lastFailureTime = null;

      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (this.state === 'half-open' || this.failureCount >= this.failureThreshold) {
        this.state = 'open';
      }

      throw error;
    } finally {
      this.halfOpenInFlight = false;
    }
  }

  getState(): CircuitState {
    // Check for automatic transition from open to half-open
    if (
      this.state === 'open' &&
      this.lastFailureTime &&
      Date.now() - this.lastFailureTime >= this.cooldownMs
    ) {
      return 'half-open';
    }

    return this.state;
  }
}
```

**Algorithm:** State machine — `closed` is normal operation, `open` rejects immediately, `half-open` lets one test through. The key insight is that you DON'T use timers — you check elapsed time lazily on each `execute()` call.

**Complexity:** O(1) per call. Space O(1).

**Edge cases to discuss:**
- Multiple requests during half-open — only the first tests, others reject (handled by `halfOpenInFlight` flag)
- Failure count should reset on success, not just on state change
- What counts as a failure — only exceptions, or also non-2xx status codes?
- Cooldown of 0 — transitions to half-open immediately
- Thread safety in Node — async calls can interleave; the `halfOpenInFlight` flag guards the critical section

**Tests:**

```typescript
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('CircuitBreaker', () => {
  it('passes through when closed', async () => {
    const fn = jest.fn(async () => 'ok');
    const breaker = new CircuitBreaker(fn, { failureThreshold: 3, cooldownMs: 1000 });

    const result = await breaker.execute();

    expect(result).toBe('ok');
    expect(breaker.getState()).toBe('closed');
  });

  it('opens after reaching failure threshold', async () => {
    let callCount = 0;
    const fn = jest.fn(async () => {
      callCount++;
      throw new Error('fail');
    });
    const breaker = new CircuitBreaker(fn, { failureThreshold: 3, cooldownMs: 1000 });

    // Trigger 3 failures
    for (let i = 0; i < 3; i++) {
      await breaker.execute().catch(() => {});
    }

    expect(breaker.getState()).toBe('open');

    // Next call should reject WITHOUT calling fn
    const beforeCount = fn.mock.calls.length;
    await expect(breaker.execute()).rejects.toThrow('Circuit breaker is open');
    expect(fn.mock.calls.length).toBe(beforeCount); // fn was NOT called
  });

  it('transitions to half-open after cooldown and recovers on success', async () => {
    let shouldFail = true;
    const fn = jest.fn(async () => {
      if (shouldFail) throw new Error('fail');
      return 'recovered';
    });

    const breaker = new CircuitBreaker(fn, { failureThreshold: 2, cooldownMs: 50 });

    // Trigger failures to open the circuit
    await breaker.execute().catch(() => {});
    await breaker.execute().catch(() => {});
    expect(breaker.getState()).toBe('open');

    // Wait for cooldown
    await delay(60);

    // Fix the underlying service
    shouldFail = false;

    // Should succeed and close the circuit
    const result = await breaker.execute();
    expect(result).toBe('recovered');
    expect(breaker.getState()).toBe('closed');
  });
});
```

**Part 2 discussion / follow-ups:**
- Combine with retry: retry N times, then trip the circuit breaker
- Sliding window failure tracking instead of consecutive count
- Half-open concurrency: only allow 1 test request, queue others
- Observability: emit events on state transitions for monitoring
- Per-endpoint circuit breakers: different breakers for different services

---

## Concurrency Concepts to Know

### Race Condition in Async JS

```typescript
// BUG: race condition on shared state
let balance = 100;

async function withdraw(amount: number): Promise<boolean> {
  if (balance >= amount) {        // Both read balance = 100
    await processPayment(amount); // Both pass the check
    balance -= amount;            // Both subtract → balance goes negative
    return true;
  }
  return false;
}

// Two concurrent withdrawals — both succeed when only one should
await Promise.all([withdraw(75), withdraw(75)]); // balance = -50 !
```

**Fix — serialize with a lock:**

```typescript
let lock = Promise.resolve();

function withdraw(amount: number): Promise<boolean> {
  const result = lock.then(async () => {
    if (balance >= amount) {
      await processPayment(amount);
      balance -= amount;
      return true;
    }
    return false;
  });

  lock = result.then(() => {});  // chain the next operation
  return result;
}
```

### Promise Concurrency Primitives

```typescript
// All must succeed — rejects on FIRST failure
await Promise.all([task1(), task2(), task3()]);

// All settle — never rejects, gives individual status
const results = await Promise.allSettled([task1(), task2(), task3()]);
// [{ status: 'fulfilled', value: ... }, { status: 'rejected', reason: ... }]

// First to finish wins — useful for timeout pattern
const result = await Promise.race([
  fetchData(),
  timeout(5000),  // rejects after 5s
]);

// Timeout helper
function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout')), ms)
  );
}

// Sleep / delay
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

### When to Use What

| Situation | Use |
|---|---|
| Run N tasks, need all results | `Promise.all` |
| Run N tasks, some may fail, need all outcomes | `Promise.allSettled` |
| Need first result (or timeout) | `Promise.race` |
| Process items with max N in-flight | Worker pool pattern |
| Collect items, process in groups | Micro-batching |
| Protect shared state from concurrent writes | Promise-based lock/mutex |

---

## Testing Guide

### Library: Jest + ts-jest

Most popular, simplest to set up, what interviewers expect.

**Setup:**

```bash
mkdir interview-prep && cd interview-prep
npm init -y
npm install -D typescript jest ts-jest @types/jest @types/node
npx tsc --init
npx ts-jest config:init
```

Verify it works:

```bash
# Create a dummy test
echo 'test("sanity", () => expect(1 + 1).toBe(2));' > sanity.test.ts
npx jest
```

### Realistic Test Strategy for a 60-Min Interview

You have 60 min total and you need to BUILD the service. Testing is important but don't spend more than 10-15 min on it. Write tests WHILE you code, not at the end.

**Write exactly 3 tests, in this priority order:**

| # | Test | Why | Time |
|---|---|---|---|
| 1 | **Happy path** — basic batch works | Proves your code runs at all | 3 min |
| 2 | **Error case** — batchFn fails | Shows you thought about failures | 3 min |
| 3 | **Behaviour** — batch fires on size OR timer | Shows you understand the core mechanic | 5 min |

That's it. Don't write more unless you have spare time. A 4th bonus test (concurrency limit assertion) is nice but not worth rushing for.

**Do NOT write:**
- Integration tests — no time, not expected
- E2E tests — completely out of scope
- Performance tests — just discuss verbally
- Edge case tests for every scenario — pick the most important one

### The 3 Tests You Should Write

```typescript
import { MicroBatcher } from './micro-batcher';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    expect(batchFn).toHaveBeenCalledTimes(1);       // ONE batch call
    expect(batchFn).toHaveBeenCalledWith([1, 2, 3]); // correct items
  });

  // TEST 2: Error case — batchFn throws, all callers rejected
  it('rejects all callers when batchFn fails', async () => {
    const batchFn = jest.fn(async () => { throw new Error('boom'); });
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

    const result = await batcher.submit(1);  // only 1 item, waits for timer

    expect(result).toBe(2);
    expect(batchFn).toHaveBeenCalledTimes(1);
  });
});
```

### Jest Cheat Sheet (Quick Reference During Interview)

```typescript
// ── Creating mocks ──
const fn = jest.fn();                              // empty mock
const fn = jest.fn(async (x) => x * 2);           // mock with implementation
const fn = jest.fn().mockResolvedValue('ok');      // always resolves with 'ok'
const fn = jest.fn().mockRejectedValue(new Error('fail')); // always rejects

// ── Assertions ──
expect(value).toBe(2);                             // strict equality
expect(value).toEqual([1, 2, 3]);                  // deep equality (arrays/objects)
expect(fn).toHaveBeenCalledTimes(1);               // call count
expect(fn).toHaveBeenCalledWith('arg1', 'arg2');   // call arguments

// ── Async assertions ──
await expect(promise).resolves.toBe('ok');         // promise resolves
await expect(promise).rejects.toThrow('boom');     // promise rejects

// ── Describe / It ──
describe('MyClass', () => {
  it('does the thing', async () => {
    // test code
  });
});
```

### If They Ask About Testing Philosophy

**Say this:** "I prioritise unit tests for business logic and behaviour. In a real codebase I'd also add integration tests for the API layer and external dependencies, but for a library like this, unit tests with mocked dependencies give you the best coverage-to-effort ratio. I write tests alongside the code — not after — because it catches design issues early."

**Bonus points if you mention:**
- "I'd use `jest.fn()` to mock the batch function so I can verify it's called with the right items"
- "For timer-based logic, Jest has fake timers, but real timers work fine for a 50ms delay in tests"
- "The concurrency limit test is a neat pattern — track `maxActive` during execution to prove the invariant"

---

## Interview Day Checklist

### Before the interview
- [ ] Boilerplate ready: `npm init -y`, TypeScript, Jest, ts-jest
- [ ] Run `npx jest` on a dummy test to confirm everything works
- [ ] Disable Copilot multi-line completions if the company asks for it (single-line is usually fine)
- [ ] Practice building MicroBatcher from scratch (timed, 45 min)
- [ ] Practice explaining race conditions out loud
- [ ] Know your 3 test cases by heart — you should be able to write them from memory

### When problem arrives (1 hour before, if pre-shared)
- [ ] Read it twice
- [ ] Identify which pattern it maps to (micro-batch, concurrency, rate limit, etc.)
- [ ] Sketch your class/function interface on paper
- [ ] List 3 edge cases you want to handle
- [ ] Do NOT start coding — just think

### During the interview (60 min)
- [ ] **0-5 min:** Ask clarifying questions out loud
  - "Should failures in one item affect others?"
  - "Do results need to be in order?"
  - "What should happen if the underlying function is slow?"
- [ ] **5-10 min:** Talk through your approach, name the pattern
- [ ] **10-35 min:** Build the core class — get happy path working FIRST
- [ ] **35-45 min:** Add error handling + edge cases
- [ ] **45-55 min:** Write 3 tests (happy path, error, timer/behaviour)
- [ ] **55-60 min:** Discuss trade-offs, extensions, what you'd add with more time
- [ ] Talk constantly — they're scoring your thought process

### Things to say out loud
- "I'm going to start with the simplest version that works, then add error handling"
- "Let me write a test for this before I move on"
- "The tricky part here is connecting individual promises to batch results"
- "I'm using splice to take the batch out of the queue so concurrent flushes don't process the same items"
- "Should I handle the case where batchFn returns fewer results than expected?"
