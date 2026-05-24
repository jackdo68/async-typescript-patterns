# Bounded Concurrency Processor Usage

## What problem it solves

You have N items to process and you want to fan them out — but firing `Promise.all` on all N at once will overwhelm whatever's downstream (rate limits, file descriptors, DB connections, memory). You want **at most K** running at any time, with everything else queued.

This is the async equivalent of a thread pool: fixed parallelism, dynamic work assignment.

---

## The worker pool pattern

The trick is **not** to slice the items into N/K chunks and process each chunk sequentially. That gives you bad utilization — if one item in a chunk is slow, the rest of the chunk's slot sits idle.

Instead, spin up **K workers**, all sharing a single index counter. Each worker grabs the next item, processes it, then immediately grabs the next. Workers go as fast as their items allow — slow items don't block fast ones.

```
items:     [A, B, C, D, E, F, G, H]
                ↑ shared index counter ↑

worker 1: A ───── D ─ E ─────── H
worker 2:   B ─ C ─── F ─── G
                                   (concurrency = 2)
```

The single counter is what gives you optimal scheduling. With chunks you'd waste capacity; with workers you saturate it.

---

## HTTP fan-out example

Scanning many domains, one HTTP request each, but the downstream API rate-limits at 5 concurrent connections:

```typescript
import { processWithConcurrency } from './service';

interface ScanResult {
  domain: string;
  rating: string;
}

async function scanOne(domain: string): Promise<ScanResult> {
  const res = await fetch(`https://api.upguard.com/v1/scan?domain=${domain}`);
  if (!res.ok) throw new Error(`scan ${domain} failed: ${res.status}`);
  return res.json();
}

const domains = ['example.com', 'test.com', /* ... 1000 more ... */];

// At most 5 in-flight at any time — respects the downstream's connection budget
const results = await processWithConcurrency(domains, scanOne, 5);

const succeeded = results.filter((r) => r.status === 'fulfilled');
const failed = results.filter((r) => r.status === 'rejected');

console.log(`scanned: ${succeeded.length}, failed: ${failed.length}`);
```

If you had used `Promise.all(domains.map(scanOne))`:
- 1000 requests fire at once → connection pool exhausted → most fail with `ECONNRESET`
- A single rejection short-circuits the whole `Promise.all`, hiding successful results.

`processWithConcurrency` fixes both: caps concurrency, and returns per-item outcomes.

---

## Result shape: why not `R[]`?

```typescript
interface ProcessResult<R> {
  status: 'fulfilled' | 'rejected';
  value?: R;
  error?: Error;
}
```

This is the same shape as `Promise.allSettled`. A plain `R[]` can't represent partial failures without polluting the type (`(R | Error)[]` works, but tagged unions read better when there are mixed outcomes).

The contract: **the function itself never rejects**. Even if every item fails, you get back an array of `{ status: 'rejected', error }` entries. This makes downstream code simple — one branch, no `try/catch` around the call site.

```typescript
const results = await processWithConcurrency(items, fn, 5);
// results is ProcessResult<R>[] — guaranteed, no try/catch needed here

for (const [i, r] of results.entries()) {
  if (r.status === 'fulfilled') handleSuccess(items[i], r.value!);
  else                          handleFailure(items[i], r.error!);
}
```

---

## Comparison with `Promise.allSettled`

```typescript
// Promise.allSettled — fires ALL at once, no concurrency limit
const results = await Promise.allSettled(items.map(fn));
// 1000 items → 1000 in-flight at once. Bad for rate-limited downstreams.

// processWithConcurrency — fires at most K at once
const results = await processWithConcurrency(items, fn, 5);
// 1000 items → 5 in-flight at any moment. Same result shape, bounded blast radius.
```

`Promise.allSettled` is the right primitive when N is small and bounded. `processWithConcurrency` is what you reach for when N could be unbounded or the downstream has limits.

---

## When does each concurrency level make sense?

| Concurrency | Use case |
|---|---|
| 1 | Effectively sequential — use when ordering or strict serialization is required |
| 2–10 | I/O against a single downstream service with conservative limits |
| 10–100 | Bulk I/O against a service with generous limits (DBs with large connection pools, internal APIs) |
| > 100 | CPU-heavy in Node? Use worker_threads instead. Otherwise you're probably hitting fd or memory limits. |

Tune by measuring downstream latency and error rate at each level. Concurrency that's too high will manifest as timeouts and connection resets, not as bigger throughput.

---

## What this pattern is NOT

### ❌ Not a rate limiter

`processWithConcurrency` limits **in-flight count**, not requests-per-second. If each `fn` call takes 10ms, concurrency 5 = 500 req/s. If you also need a per-second cap, combine with a token-bucket rate limiter (see `rater-limited-fetcher`).

### ❌ Not a retry loop

If an item fails, it stays failed. Add retry logic *inside* `fn` if individual items should be retried:

```typescript
const fnWithRetry = async (item: string) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await scanOne(item); }
    catch (e) { if (attempt === 2) throw e; await delay(2 ** attempt * 100); }
  }
  throw new Error('unreachable');
};

await processWithConcurrency(items, fnWithRetry, 5);
```

### ❌ Not a cancellation primitive

There's no way to abort items mid-flight. If you need cancellation, pass an `AbortSignal` into `fn` and let `fn` plumb it into `fetch` / your I/O call.

---

## Edge cases worth knowing

- **Empty input:** returns `[]` immediately. No workers spawned.
- **`concurrency > items.length`:** capped at `items.length` — you don't spin up idle workers.
- **`concurrency === 0`:** no workers run → returns an array of `undefined` slots. Treat 0 as a bug; either guard the caller or throw.
- **One item hangs forever:** that worker is stuck on it, but the other K-1 keep draining the queue. The whole call still doesn't resolve until the hung item finishes. Combine with `Promise.race` against a timeout if you need a hard ceiling.
- **`fn` is synchronous but errors:** the `try/catch` still works because `async` wraps the throw into a rejection.

---

## Combining with other patterns

This is the standard "fan-out controller" piece — most real systems wrap it around something else:

```typescript
// Fan out scans across many domains, but each scan goes through a MicroBatcher
// that coalesces calls to the bulk endpoint:
const results = await processWithConcurrency(
  customerDomains,
  (domain) => scanBatcher.submit(domain),   // MicroBatcher under the hood
  10,
);

// Fan out, with each item retried up to 3x and timeout-bounded:
const fn = withRetry(withTimeout(scanOne, 5000), 3);
const results = await processWithConcurrency(domains, fn, 5);
```

---

## TL;DR

- Workers pull from a shared index counter — optimal scheduling, no idle slots.
- Function never rejects; returns one `ProcessResult` per item with `status: 'fulfilled' | 'rejected'`.
- Caps **in-flight count**, not requests/sec. Pair with a rate limiter if you need both.
- Caps workers at `min(concurrency, items.length)` so you don't spin up idle workers.
- The standard fan-out primitive — usually layered with retries, timeouts, batching, or rate limits on top.
