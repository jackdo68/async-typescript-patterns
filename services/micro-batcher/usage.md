# MicroBatcher Usage

## One `batchFn` per MicroBatcher instance

Each MicroBatcher instance is bound to exactly **one** `batchFn` at construction. If you have multiple bulk operations (scan domains, lookup vendors, check certs), you spin up multiple MicroBatcher instances — each with its own `batchFn` and its own `maxBatchSize`/`maxWaitMs` tuned for that operation.

That's intentional: keeps the batcher dumb and reusable. Different operations have different tradeoffs — a fast in-memory lookup might want `maxWaitMs: 5`, a slow external API might want `maxWaitMs: 200`.

---

## HTTP request example

Imagine UpGuard has a domain-scanning API.

**Single-item endpoint** (what a naive caller would use):

```
POST /api/v1/scan
Body: { "domain": "example.com" }
Response: { "domain": "example.com", "rating": "A", ... }
```

**Bulk endpoint** (what we want to use under the hood):

```
POST /api/v1/scan/bulk
Body: { "domains": ["example.com", "test.com", "foo.com"] }
Response: { "results": [
  { "domain": "example.com", "rating": "A", ... },
  { "domain": "test.com",    "rating": "B", ... },
  { "domain": "foo.com",     "rating": "F", ... }
]}
```

### End-to-end example

```typescript
import { MicroBatcher } from './service';

// What ONE caller looks like — they get a single result back
interface ScanResult {
  domain: string;
  rating: string;
  issues: string[];
}

// The batchFn — knows how to call the bulk endpoint
const scanBatchFn = async (domains: string[]): Promise<ScanResult[]> => {
  const res = await fetch('https://api.upguard.com/v1/scan/bulk', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.UPGUARD_TOKEN}`,
    },
    body: JSON.stringify({ domains }),
  });

  if (!res.ok) {
    // Throwing here → MicroBatcher rejects ALL callers in this batch
    throw new Error(`Bulk scan failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  return json.results;  // must be same length & order as `domains`
};

// Create ONE batcher for this operation
const scanBatcher = new MicroBatcher<string, ScanResult>(scanBatchFn, {
  maxBatchSize: 50,    // bulk endpoint accepts up to 50 per call
  maxWaitMs: 100,      // don't make callers wait more than 100ms
});

// ─────────────────────────────────────────────
// Now any caller anywhere in your app does this:
// ─────────────────────────────────────────────

async function handleUserDashboard(userDomains: string[]) {
  // Each call returns a promise. Each caller still gets their OWN result.
  const results = await Promise.all(
    userDomains.map(d => scanBatcher.submit(d))
  );
  return results;
}
```

---

## What actually happens on the wire

Let's say 3 different HTTP request handlers, in 3 different parts of your app, each call `scanBatcher.submit()` within ~50ms of each other:

```
t=0ms    Handler A: scanBatcher.submit("example.com")  → returns Promise P1
                   queue = [example.com]
                   timer starts (will fire at t=100ms)

t=15ms   Handler B: scanBatcher.submit("test.com")     → returns Promise P2
                   queue = [example.com, test.com]
                   timer already running, don't restart

t=30ms   Handler C: scanBatcher.submit("foo.com")      → returns Promise P3
                   queue = [example.com, test.com, foo.com]

t=100ms  Timer fires → flush()
                   ┌─────────────────────────────────────────┐
                   │ ONE HTTP request goes out:              │
                   │   POST /api/v1/scan/bulk                │
                   │   { "domains": ["example.com",          │
                   │                  "test.com",            │
                   │                  "foo.com"] }           │
                   └─────────────────────────────────────────┘

t=180ms  Response arrives:
                   { "results": [
                       { "domain": "example.com", "rating": "A" },
                       { "domain": "test.com",    "rating": "B" },
                       { "domain": "foo.com",     "rating": "F" }
                   ]}

                   MicroBatcher does:
                     P1.resolve({ domain: "example.com", rating: "A" })
                     P2.resolve({ domain: "test.com",    rating: "B" })
                     P3.resolve({ domain: "foo.com",     rating: "F" })

                   Handler A, B, C each unblock with their own result.
```

**Without the batcher:** 3 separate HTTP requests → 3 TCP/TLS handshakes (or 3 trips through the connection pool), 3 auth header verifications on the server, 3× the request parsing overhead. At UpGuard's scale (millions of domains/day) this is the difference between "feasible" and "your bill explodes."

**With the batcher:** 1 HTTP request, 1 handshake, 1 auth check, 1 round-trip. ~50× fewer requests for `maxBatchSize: 50`.

---

## Multiple batchers in the same app

You'd typically have several batcher instances coexisting, each wrapping a different bulk endpoint:

```typescript
// Domain scans — slower operation, larger batches OK
export const scanBatcher = new MicroBatcher(scanBatchFn, {
  maxBatchSize: 50, maxWaitMs: 100
});

// Vendor lookups — fast endpoint, tighter latency budget
export const vendorBatcher = new MicroBatcher(vendorLookupBatchFn, {
  maxBatchSize: 20, maxWaitMs: 20
});

// Sending Slack alerts — slow webhook, batch aggressively
export const slackBatcher = new MicroBatcher(slackPostBatchFn, {
  maxBatchSize: 100, maxWaitMs: 500
});
```

Each batcher is independent — its own queue, its own timer, its own `batchFn`. They don't interact.

---

## What `batchFn` is NOT

```typescript
// ❌ This is pointless — you're just iterating, not batching
const batchFn = async (urls: string[]) => {
  return Promise.all(urls.map(url => scanOne(url)));  // N individual calls
};
```

If `batchFn` just loops and calls a single-item function N times, you've made zero requests fewer to the downstream system. You may as well have skipped the batcher entirely.

## What `batchFn` IS

It exploits a **bulk API** or **bulk operation** that the underlying system supports — one call that does N things more cheaply than N calls.

```typescript
// ✅ One HTTP call sends all URLs to a bulk endpoint
const batchFn = async (urls: string[]) => {
  const res = await fetch('https://api.upguard.com/scan/bulk', {
    method: 'POST',
    body: JSON.stringify({ urls }),
  });
  return res.json();  // returns array of results, one per URL
};

// ✅ One SQL query inserts/fetches many rows
const batchFn = async (ids: number[]) => {
  return db.query('SELECT * FROM users WHERE id = ANY($1)', [ids]);
};

// ✅ One LLM call with multiple prompts (e.g., Anthropic batch API)
const batchFn = async (prompts: string[]) => {
  return anthropic.messages.batches.create({ requests: prompts });
};

// ✅ One Kafka publish with N records instead of N individual publishes
const batchFn = async (events: Event[]) => {
  return producer.sendBatch(events);
};
```

The win comes from amortizing **per-call overhead** — TCP handshake, TLS, auth, request parsing, transaction setup, network round-trip — across many items. One round-trip for 100 items is dramatically cheaper than 100 round-trips for 1 item each.

---

## When does batching actually help?

| Cost dominated by | Batching helps? |
|---|---|
| Network round-trip latency | **Yes** — one round-trip vs N |
| Auth/TLS handshake (with connection pooling already in place) | Small win |
| DB transaction setup | **Yes** — one transaction vs N |
| Per-row CPU in the underlying service | **No** — same total work |
| Rate limits priced per *request* (not per item) | **Yes** — 1 request vs N |

---

## The contract `batchFn` must maintain

Whatever `batchFn` does internally, two things must be true:

1. **Order preserved**: `results[i]` corresponds to `items[i]`. The MicroBatcher relies on this to map results back to the right caller.
2. **Length matched**: `results.length === items.length` — the MicroBatcher defensively rejects when results are short.

### Edge case: bulk APIs that don't preserve order

Sometimes the bulk API returns `{id, result}` objects in arbitrary order. In that case `batchFn` is responsible for reordering before returning:

```typescript
const batchFn = async (ids: number[]) => {
  const responses = await fetchBulk(ids);  // returns [{id, data}, ...] in any order
  const byId = new Map(responses.map(r => [r.id, r.data]));
  return ids.map(id => byId.get(id));  // reorder to match input
};
```

---

## Micro vs Macro batching

**Macro-batching** = traditional batch processing. Accumulate work for minutes, hours, or until end-of-day, then process huge batches (thousands to millions of items) in one go. Think nightly ETL jobs, daily report generation, end-of-month billing runs. High throughput, but **high latency** — a request submitted at 9am might not be processed until midnight.

**Micro-batching** = the sweet spot between "one at a time" and "huge batches." Accumulate for **milliseconds to a few seconds**, batch is small (tens to low hundreds of items), then flush. You get most of the throughput benefit of batching while keeping latency low enough for interactive/online use.

Look at typical MicroBatcher defaults — `maxWaitMs: 100`, `maxBatchSize: 10`. That's micro:

- Caller still gets their result back in ~100ms worst case
- But `batchFn` is called once instead of 10 times
- Best of both worlds for online systems

If you bumped those to `maxWaitMs: 3600000, maxBatchSize: 10000`, you'd have macro-batching — fine for an overnight job, useless if a user is waiting on the other end.

### Where the term comes from

Popularized by **Spark Streaming** (~2013), which processed streams by chopping them into tiny batches (e.g., every 500ms) rather than true event-at-a-time streaming. "Micro-batch streaming" became standard vocabulary.

In the API/RPC world it shows up in libraries like Facebook's **DataLoader** — coalesces individual lookups within a single event-loop tick into one batched fetch. Same core mechanism, slightly different lifecycle (one DataLoader per request, not per app).

---

## TL;DR

- One `batchFn` per MicroBatcher instance — the batcher is a single-purpose coalescer
- `batchFn` should call a **bulk endpoint**, not loop over a single-item endpoint
- Contract: same length out as in, same order
- For multiple bulk operations, instantiate multiple batchers — each tuned to its operation's latency and batch-size characteristics
- "Micro" = milliseconds of buffering, small batches → keeps online latency low while still amortizing per-call overhead
