# Rate-Limited Fetcher Usage

## What problem it solves

You're calling an upstream API that has **two independent limits**:

1. **Concurrency** — "no more than 5 requests in flight at once" (typically driven by their connection pool or thread budget).
2. **Throughput** — "no more than 10 requests per second" (typically driven by quota / billing / fair-use rules).

`Promise.all` and `processWithConcurrency` only handle the first. `RateLimitedFetcher` handles both — and does so for a **stream of independent callers** over time, not just a single batched call.

---

## Why both limits matter

```
maxConcurrent = 5, each request takes 50ms
→ instantaneous concurrency: capped at 5
→ sustained rate: ~100 req/s   (5 slots × 20 turnovers/sec)

If the upstream's actual quota is 10 req/s, the concurrency limit
alone does nothing. You burst right past their per-second cap
and get 429s.
```

The per-second cap is what protects you against high-turnover fast endpoints. The concurrency cap is what protects you against slow endpoints (which would otherwise pile up unboundedly even at a low req/sec rate).

In production, **you usually need both**.

---

## Basic usage

```typescript
import { RateLimitedFetcher } from './service';

// Wire one instance per upstream — its limits are per-instance.
export const upguardFetcher = new RateLimitedFetcher({
  maxConcurrent: 5,
  maxPerSecond: 10,
});

// Anywhere in your app:
const response = await upguardFetcher.fetch('https://api.upguard.com/v1/scan');
const data = await response.json();
```

The shape mirrors `globalThis.fetch` — it returns a `Response`. You can pass a second argument for headers/method/body:

```typescript
await upguardFetcher.fetch('https://api.upguard.com/v1/scan', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ domain }),
});
```

---

## The streaming use case (where it shines)

The batch use looks unremarkable:

```typescript
// Looks like processWithConcurrency, but with a per-second cap on top.
await Promise.all(urls.map((u) => fetcher.fetch(u)));
```

The interesting case is **independent callers over time**:

```typescript
// HTTP handler A
app.get('/scan/:domain', async (req, res) => {
  const result = await upguardFetcher.fetch(`https://api.upguard.com/scan?d=${req.params.domain}`);
  res.json(await result.json());
});

// Background job
async function nightlyRefresh(domains: string[]) {
  for (const d of domains) {
    await upguardFetcher.fetch(`https://api.upguard.com/scan?d=${d}`);
  }
}

// Webhook listener
app.post('/webhook', async (req, res) => {
  await upguardFetcher.fetch('https://api.upguard.com/audit', { method: 'POST', body: req.body });
});
```

Three completely independent code paths, all calling the same shared `upguardFetcher`. The limiter coordinates **across all of them** — the user-facing handler doesn't get starved by the background job, and none of them collectively exceed the upstream's 10 req/s cap.

`processWithConcurrency` can't do this — it only knows about a single array handed to it. `RateLimitedFetcher` is a long-lived shared coordinator.

---

## How the two limits combine

A request can `acquireSlot()` only when **both** of these are true:

1. `activeConcurrent < maxConcurrent` — there's a parallelism slot free.
2. `timestamps.length < maxPerSecond` — fewer than N requests have *started* in the last 1000ms.

If either condition fails, the request goes into the queue and waits for `releaseNextWaiter()` to wake it.

```
       request arrives
              │
              ▼
       ┌──────────────┐
       │ tryAcquire() │
       └──────┬───────┘
              │
   ┌──────────┴──────────┐
   │ concurrency free?   │── no ──┐
   │ AND under rate cap? │        │
   └──────────┬──────────┘        │
              │ yes               │
              ▼                   ▼
       run the fetch         join queue
              │                   │
              ▼                   ▼
          finally:        woken on slot free
       activeConcurrent--      OR window slide
              │
              ▼
       releaseNextWaiter()
```

---

## The sliding-window mechanism

The per-second limit is enforced by a **sliding window** over the `timestamps` array:

```typescript
const now = Date.now();
this.timestamps = this.timestamps.filter((t) => t > now - 1000);

if (this.timestamps.length < this.maxPerSecond) {
  this.timestamps.push(now);
  // acquire
}
```

Each entry records when a request *started* (not when it finished). On every `acquireSlot()` we drop entries older than 1 second, then count what's left. If the count is below the cap, we acquire; otherwise we queue.

This is subtly different from a **fixed window** (e.g., "0–1000ms, 1000–2000ms, ..."): with a fixed window you can burst right at the boundary (10 at 999ms + 10 at 1001ms = 20 in 2ms). With a sliding window the count includes anything in the previous 1000ms, so bursts are smoothed.

A more efficient variant in prod is a **token bucket** — same effect but O(1) per check instead of O(window-size). The sliding window in this code is simpler and fine up to a few hundred timestamps.

---

## Comparison with what you've already seen

| Need | Use |
|---|---|
| Run a known list of items, cap parallelism | `processWithConcurrency` |
| Run a known list, cap parallelism AND rate | `RateLimitedFetcher` + `Promise.all` |
| Independent callers across the app, coordinate against an upstream's limits | `RateLimitedFetcher` |
| Coalesce many single-item calls into one bulk call | `MicroBatcher` |
| Coalesce many calls AND rate-limit the bulk calls | `MicroBatcher` whose `batchFn` uses a `RateLimitedFetcher` |

These compose. A common production stack: HTTP handlers fan out via `processWithConcurrency` → each item goes through a `MicroBatcher` → the batcher's `batchFn` calls `RateLimitedFetcher.fetch()`.

---

## Edge cases worth knowing

- **Boundary timing on the 1-second window.** The window is exactly 1000ms. A burst exactly at the boundary will be admitted as soon as the oldest timestamp ages out. Real clocks aren't monotonic — `Date.now()` can go backwards on NTP corrections. For production, use `performance.now()` and pin the policy to monotonic time.
- **Unbounded queue.** Nothing here caps queue size. If callers arrive faster than the upstream rate forever, queue grows unboundedly → memory blow-up. Add a `maxQueueSize` and reject (or shed load) when exceeded.
- **Starvation in `releaseNextWaiter`.** This implementation wakes one waiter per slot release. Order is FIFO from the queue — first in, first served. If you wake more aggressively (e.g., loop until the rate cap is hit again) you'll get faster ramp-up but more work per slot release.
- **fetch rejection.** The `finally` releases the concurrency slot but the timestamp stays in the window. That's correct — the timestamp represents "we *started* a request", and the upstream's rate limiter saw that request go out regardless of how it ended.
- **Single instance per upstream.** Different APIs have different limits — wire one `RateLimitedFetcher` per upstream, not one for the whole app. Sharing one across upstreams either over-throttles one or under-protects another.

---

## What this pattern is NOT

### ❌ Not retries

If a request fails with `429`, this won't retry it. Wrap with a retry/backoff function before passing to `fetch`, or layer a retry primitive around the call site.

### ❌ Not a queue with priorities

All waiters are FIFO. If you need "user-facing requests jump background jobs," use two separate fetchers with budgets split between them, or extend with a priority queue.

### ❌ Not per-route limiting

The limits are per `RateLimitedFetcher` instance, not per URL. If your upstream has different limits for `/scan` vs `/audit`, you need two fetchers.

### ❌ Not distributed

This is in-process state. Two pods running this code each get their own count — they don't coordinate. For multi-instance deploys against a shared upstream, use a centralized limiter (Redis token bucket, Envoy filter, the upstream's own API gateway).

---

## TL;DR

- Caps **two** things: concurrency (in-flight count) and rate (starts per second). Different mechanisms; both needed in real systems.
- Sliding-window timestamp list for the rate cap; counter for the concurrency cap; FIFO queue when either is exhausted.
- Long-lived shared coordinator — wire one per upstream, callers anywhere in the app go through it.
- Doesn't retry, prioritize, or coordinate across processes — compose with other primitives if you need those.
