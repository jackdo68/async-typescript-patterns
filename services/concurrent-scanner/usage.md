# Concurrent Scanner Usage

## What problem it solves

You want to run **many independent checks against the same target** and produce one aggregated report. Examples:

- Domain security scan: TLS config, DNS records, open ports, HTTP headers, WHOIS — all independent, all should run together.
- Service health probe: liveness, readiness, downstream dependency checks, disk space, queue depth.
- PR pre-merge gate: lint, unit tests, type-check, license-scan — each independent, each reported.

The three invariants:

1. **Independence** — one failing check must not abort the others. You want partial results, not all-or-nothing.
2. **Concurrency** — total wall time should equal the *slowest* check, not the sum of all of them.
3. **Bounded latency** — a hung check must not hold up the report. Each check has a hard ceiling.

That's `Promise.allSettled` + per-check `Promise.race` against a timeout, packaged with type-safe per-check result lookup.

---

## Basic usage

```typescript
import { DomainScanner } from "./service";

const scanner = new DomainScanner(
  {
    tls: async (domain) => checkTLS(domain),           // returns { version: string }
    dns: async (domain) => checkDNS(domain),           // returns { hasDNSSEC: boolean }
    ports: async (domain) => checkPorts(domain),       // returns number[]
    headers: async (domain) => checkHeaders(domain)    // returns { hasHSTS: boolean }
  },
  { timeoutMs: 5_000 }
);

const report = await scanner.scan("example.com");

// report.target     → "example.com"
// report.scannedAt  → Date
// report.results.tls     → { status: "passed", data: { version: "TLSv1.3" } }
//                            | { status: "error",  error: "..." }
// report.results.ports   → { status: "passed", data: [80, 443] }
//                            | { status: "error",  error: "..." }
```

Note: `report.results.tls.data` is typed as `{ version: string }` — the check map's signatures flow through, so callers get per-check type information for free.

---

## Why `Promise.allSettled`, not `Promise.all`

`Promise.all` rejects on the first failure and discards every other result — exactly the wrong shape for a scan.

```typescript
// ❌ One failed check loses every other result
await Promise.all([checkTLS(), checkDNS(), checkPorts()]);
// → throws if DNS fails. TLS + ports results are gone.

// ✅ Every outcome surfaces; nothing aborts
await Promise.allSettled([checkTLS(), checkDNS(), checkPorts()]);
// → [{ status: "fulfilled", value }, { status: "rejected", reason }, { status: "fulfilled", value }]
```

`Promise.allSettled` is the right primitive any time you want **partial results from independent work**. The scanner just packages it with a per-check timeout and turns the array of outcomes back into a name-keyed object.

---

## The timeout pattern — `Promise.race` with cleanup

A check that hangs forever would otherwise block the entire scan. Each check is raced against a per-check timeout:

```typescript
let timeoutId: NodeJS.Timeout | undefined;
const timeout = new Promise<never>((_, reject) => {
  timeoutId = setTimeout(
    () => reject(new Error(`check "${name}" timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
});

try {
  return await Promise.race([fn(target), timeout]);
} finally {
  if (timeoutId) clearTimeout(timeoutId);
}
```

Two subtleties:

- **`Promise<never>` for the timeout** — it only ever rejects, never resolves. Typing it as `never` tells TS the race's success value comes solely from `fn(target)`.
- **`clearTimeout` in `finally`** — if the check resolves first, the timer would otherwise stay armed and fire later, holding the event loop open. Always cancel timers when the race ends.

⚠️ `Promise.race` does NOT cancel the loser. If the check is a slow `fetch`, it keeps running in the background even after the timeout reports it. For real cancellation, pass an `AbortSignal` into the check and `.abort()` it when the timer fires.

---

## Why a check map, not an array of `{ name, fn }`

The map shape:

```typescript
new DomainScanner({
  tls: async (d) => ...,
  dns: async (d) => ...
});
```

…gives you two wins over `[{ name: "tls", fn: ... }, ...]`:

1. **Per-key types flow through.** `report.results.tls.data` knows the exact return type of the `tls` check. With a string-keyed array, every result widens to `unknown`.
2. **Name uniqueness is enforced by TypeScript** — duplicate keys are an object-literal error, not a silent overwrite.

The trade-off: the map is built once at construction. If you want to add checks dynamically, you'll lose the typed-results benefit and should switch to an array shape.

---

## Comparison with related patterns

| Pattern | Shape of work | When you'd reach for it |
|---|---|---|
| `DomainScanner` | one target, many heterogeneous checks | aggregate independent probes into one report |
| `processWithConcurrency` | many homogeneous items, one function | fan out the same operation over a list |
| `Promise.all` | small fixed set of dependent calls | every result is required; one failure aborts the rest |
| `Promise.allSettled` | small fixed set of independent calls | same as scanner but without timeout / aggregation packaging |

`DomainScanner` is essentially `Promise.allSettled` + per-call timeout + typed name → result mapping. If you don't need timeouts and your checks are ad-hoc, `Promise.allSettled` directly is fine.

---

## Composing with other patterns

Scan many targets, bounded concurrency:

```typescript
import { processWithConcurrency } from "../bounded-concurrency-processor/service";

const scanner = new DomainScanner({ tls, dns, ports }, { timeoutMs: 5_000 });

const reports = await processWithConcurrency(
  customerDomains,
  (domain) => scanner.scan(domain),
  10                                          // 10 concurrent scans
);
```

Cache scan results for a TTL:

```typescript
import { TTLCache } from "../cache/service";

const scannerCache = new TTLCache(
  (domain) => scanner.scan(domain),
  { ttlMs: 60_000 }
);

// Repeat scans for the same domain inside 60s hit the cache;
// concurrent calls for the same domain dedupe to one scan.
await scannerCache.get("example.com");
```

---

## Edge cases worth knowing

- **Empty check map** — `scan()` resolves with an empty `results` object. Useful no-op for tests / feature flagging individual checks off.
- **All checks fail** — you still get a valid report with every entry marked `{ status: "error", error }`. The scan itself never rejects.
- **Check returns `null` or `undefined`** — counts as `passed` with `data: null/undefined`. The contract is "did it throw," not "is the result truthy."
- **Check throws synchronously inside an `async` function** — `async` converts the throw to a rejection, which `allSettled` handles. A non-async function that throws would propagate; wrap in `async` to be safe.
- **Timeout fires but the check eventually resolves** — the result is discarded (race already settled). Make sure the check doesn't have side effects that mutate state after a "timed-out" report goes back to the caller, or use an `AbortSignal`.
- **Same scanner used across many `scan()` calls concurrently** — the scanner holds no per-scan state, so it's safe to share.

---

## What this pattern is NOT

### ❌ Not a cancellation primitive

The timeout reports a check as failed, but it cannot stop the underlying I/O. The check keeps running until it naturally finishes. For real cancellation, pipe an `AbortSignal` into your check function and abort it from the timeout callback.

### ❌ Not a retry mechanism

A failed check stays failed. If individual checks are flaky and should be retried, wrap the check function with retry logic before passing it in.

### ❌ Not for *dependent* checks

If check B needs the result of check A, this is the wrong shape — `Promise.allSettled` runs them in parallel from the same starting point. For dependency graphs, model the dependencies explicitly (await A, then run B).

### ❌ Not a rate limiter

If your checks all hit the same downstream, `DomainScanner` will happily fire them concurrently. Combine with a `RateLimitedFetcher` inside the check if the downstream has limits.

---

## TL;DR

- `Promise.allSettled` for independence + concurrency + partial results.
- Per-check `Promise.race(checkFn, timeout)` with `clearTimeout` in `finally` for bounded latency.
- Typed check map → typed `results[key].data` for free.
- Total wall time = slowest check (or its timeout), not the sum.
- Timeout marks a check failed; it does NOT cancel the underlying work — use `AbortSignal` if you need real cancellation.
