# TTL Cache Usage

## What problem it solves

You're calling something expensive — a slow API, a heavy DB query, a fan-out to many services — and the same input shows up over and over. You want two things:

1. **TTL caching** — once you've computed the answer for `key=foo`, hand it back without recomputing for the next N seconds.
2. **Thundering-herd protection** — if 100 requests for `key=foo` arrive while the first one is still in flight, do NOT fire 100 underlying fetches. Make them all wait on the same Promise.

A naïve `Map<string, T>` gets you (1) but not (2), and (2) is where production caches actually break under load.

---

## Basic usage

```typescript
import { TTLCache } from "./service";

interface User {
  id: string;
  name: string;
}

const userCache = new TTLCache<User>(
  async (id) => {
    const res = await fetch(`/api/users/${id}`);
    if (!res.ok) throw new Error(`user ${id} fetch failed: ${res.status}`);
    return res.json();
  },
  { ttlMs: 60_000 }
);

// First call → fetches and caches
const u1 = await userCache.get("u-123");

// Within 60s → returns the cached value, no HTTP call
const u2 = await userCache.get("u-123");

// After 60s → fetches again
```

`get(key)` is the only entry point. `fetchFn` is invoked only on misses (or expirations); the cache hides that from callers.

---

## The thundering-herd problem (and why it matters)

Picture a popular endpoint with a 50ms backend call. A spike of 100 concurrent requests for the same key arrives:

```
Without dedup:
  request 1 → MISS → fires fetch
  request 2 → MISS (no entry yet) → fires fetch
  request 3 → MISS → fires fetch
  ...
  request 100 → MISS → fires fetch
  → 100 backend calls for ONE logical lookup. Backend melts.
```

The fix is to store the **in-flight Promise**, not just the eventual value. Concurrent callers find the Promise and await it instead of firing their own fetch:

```typescript
async get(key: string): Promise<T> {
  const cached = this.cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const existing = this.inFlight.get(key);
  if (existing) return existing;          // ← join the in-flight fetch

  const fetchPromise = this.fetchAndCache(key);
  this.inFlight.set(key, fetchPromise);
  try   { return await fetchPromise; }
  finally { this.inFlight.delete(key); }
}
```

```
With dedup:
  request 1 → MISS → fires fetch, stores Promise in inFlight
  request 2 → in inFlight → awaits same Promise
  ...
  request 100 → in inFlight → awaits same Promise
  → 1 backend call. All 100 callers resolve together when it lands.
```

This is sometimes called **request coalescing**. It's the single most important property of a production cache — without it, your cache *amplifies* load spikes during cold starts instead of absorbing them.

---

## Two maps, two purposes

```typescript
private cache    = new Map<string, CacheEntry<T>>();   // settled values + expiry
private inFlight = new Map<string, Promise<T>>();      // in-flight fetches
```

- **`cache`**: holds resolved values with their `expiresAt` timestamp. Lookup is O(1).
- **`inFlight`**: holds the Promise for any key currently being fetched. Entries are deleted in the `finally` block — success or failure, the slot frees up so a future call can retry.

A failed fetch is deliberately NOT cached. The Promise lives in `inFlight` only long enough for current waiters to receive the rejection; then the entry is removed. The next `get` will retry — which is usually what you want for a transient upstream failure.

---

## Why timestamp expiry, not `setTimeout`

You could schedule a `setTimeout(() => cache.delete(key), ttlMs)` per entry. Don't.

- Timers keep the event loop alive — N cached entries = N pending timers.
- If you `invalidate()` early, you have to track and clear the timer.
- Process restart or `clearTimeout` bugs leave entries that never expire.

Storing `expiresAt: Date.now() + ttlMs` and checking it lazily on `get()` is simpler, has no background work, and the cost is one comparison per lookup. Entries linger in the Map until either `get` evicts the stale one or `invalidate`/`clear` is called — that's a memory consideration, not a correctness one. (For unbounded keyspaces, add LRU eviction or periodic sweeping.)

---

## Failure semantics

When `fetchFn` rejects:

1. The rejection propagates to **every** caller that joined the in-flight Promise.
2. The `inFlight` entry is removed in `finally` — so the next `get(key)` will retry from scratch.
3. **Nothing is cached.** A failed fetch leaves no entry in `cache`.

This is the right default for transient failures (network blip, upstream 503). If you want negative caching (remember failures briefly to avoid hammering a known-broken upstream), add it explicitly — store a sentinel entry with a short TTL on catch. Don't conflate it with success caching.

---

## Comparison with related patterns

| Pattern | What it bounds | When you'd reach for it |
|---|---|---|
| `TTLCache` | computation cost over time | repeated reads of the same data, where staleness up to TTL is fine |
| `RateLimitedFetcher` | requests-per-second + in-flight | you control the request rate to a downstream |
| `processWithConcurrency` | in-flight workers | one-shot fan-out over a known list |
| `MicroBatcher` | upstream call count via batching | many small calls collapsed into one bulk call |

They compose well. A common stack is **cache → batcher → upstream**: the cache answers hot keys, misses fall through to a batcher that coalesces them into bulk calls, which a rate-limited fetcher sends upstream.

---

## Edge cases worth knowing

- **`ttlMs: 0`** — every `get` is a miss, but concurrent gets for the same key still dedupe. Effectively pure request coalescing, no temporal caching.
- **Cache size unbounded** — entries are kept until invalidated or replaced. For bounded keyspaces (user IDs, etc.) this is fine; for unbounded ones (e.g. URLs), add an LRU on top.
- **Clock skew / system time changes** — `Date.now()` is wall-clock. If the clock jumps backward, entries appear fresh for longer; if forward, they expire early. Usually fine; if not, use a monotonic clock.
- **`invalidate` during in-flight fetch** — the in-flight Promise still completes and writes to `cache`. If you need invalidate to discard the result, track a generation counter and skip the write if it changed.
- **Async fetch that resolves *after* TTL has elapsed in another caller's view** — the value is still written to `cache` with `Date.now() + ttlMs` *at write time*. So a 100ms fetch with a 50ms TTL gives every caller ~50ms of cached value from the moment the fetch lands, not from when it was requested.

---

## What this pattern is NOT

### ❌ Not an LRU

There's no size cap and no eviction policy. For unbounded keyspaces, wrap or replace the internal `Map` with an LRU implementation.

### ❌ Not stale-while-revalidate

On expiry, the next `get` blocks until the fresh value arrives. If you want to serve the stale value immediately while refreshing in the background, you'd extend `get` to return `cached.value` and kick off a background fetch when `expiresAt` is in the past.

### ❌ Not distributed

This is in-process state. Two pods get independent caches and independent in-flight maps — request coalescing only works *within* a process. For cross-process dedup you need a shared store (Redis with `SETNX`-style locks, or a request coalescing proxy).

### ❌ Not negative-caching

Failures are deliberately not cached. If your upstream is "permissively broken" (returns 404 for keys that genuinely don't exist), add a negative-cache layer rather than conflating it with this.

---

## TL;DR

- `Map` of `{ value, expiresAt }` for TTL, plus a separate `Map` of in-flight `Promise`s for dedup.
- Thundering-herd protection is the headline feature — N concurrent callers for the same key share ONE fetch.
- Failures are NOT cached; the next `get` retries.
- Lazy expiry on `get`; no background timers.
- In-process only; not an LRU; not stale-while-revalidate. Layer those on if you need them.
