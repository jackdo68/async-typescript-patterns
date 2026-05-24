# Circuit Breaker Usage

## What problem it solves

You're calling something unreliable (an upstream API, a flaky downstream service). When it starts failing, three things go wrong if you keep hammering it:

1. **Your latency explodes** — every call waits for the upstream timeout before failing.
2. **You make the upstream's recovery slower** — pile-on traffic during an outage prevents it from draining queues and reclaiming capacity.
3. **You waste your own resources** — each in-flight call ties up a connection, a thread, an event-loop slot.

A circuit breaker is a **state machine in front of the call** that learns when the upstream is broken and short-circuits subsequent calls — rejecting them locally, with no network round-trip, until a cooldown elapses and the breaker probes the upstream again.

> Note: the folder is named `retry/` to track the "Retry with Circuit Breaker" theme. This module implements the **circuit breaker** half — see "Composing with retries" below for how to layer retry logic on top.

---

## The three states

```
                       failures ≥ threshold
              ┌─────────────────────────────────────►
   ┌──────────┴────┐                              ┌────────┐
   │    CLOSED     │                              │  OPEN  │
   │ (normal flow) │                              │ (reject │
   │               │ ◄────────────────────────── │ locally) │
   └───────┬───────┘     test request succeeds   └────┬─────┘
           ▲                                          │
           │                                          │ cooldown elapsed
           │                                          ▼
           │ test request           ┌──────────────────────┐
           └──────────────────────  │     HALF-OPEN        │
              succeeds              │  (one probe through) │
                                    └──────────────────────┘
                                          │
                                          │ test fails
                                          ▼
                                       OPEN
```

- **Closed** — the default. Calls go through. Consecutive failures are counted. When count hits `failureThreshold`, the breaker trips → `open`.
- **Open** — calls are rejected immediately with a `CircuitOpenError`. The upstream is not touched. After `cooldownMs` elapses since the last failure, the breaker becomes eligible to **probe** → `half-open`.
- **Half-open** — exactly **one** call is allowed through as a test. Other concurrent calls reject immediately. If the test succeeds → `closed` (full recovery). If it fails → `open` (try again after another cooldown).

---

## Basic usage

```typescript
import { CircuitBreaker, CircuitOpenError } from "./service";

const breaker = new CircuitBreaker(
  async () => {
    const res = await fetch("https://api.example.com/scan");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  { failureThreshold: 5, cooldownMs: 10_000 }
);

try {
  const data = await breaker.execute();
  // ...
} catch (err) {
  if (err instanceof CircuitOpenError) {
    // Upstream known-bad — fall back to a cached value, a default, or a queued retry.
    return serveStaleFromCache();
  }
  // Otherwise it's a real upstream error
  throw err;
}
```

The breaker wraps a single function. If you have many endpoints, give each its own breaker — one tripping shouldn't poison the others.

---

## Lazy state transitions — no timers

A common mistake is to manage the `open → half-open` transition with a `setTimeout`. Don't.

- A long-lived breaker that's never invoked keeps a timer alive for nothing.
- Process restarts wipe in-memory timers; the breaker would stay open forever.
- Concurrent calls plus an asynchronous transition introduces race windows.

Instead, transitions are checked **lazily on every `execute()` call**:

```typescript
if (this.state === "open") {
  if (this.cooldownElapsed()) {
    this.state = "half-open";
  } else {
    throw new CircuitOpenError();
  }
}
```

The cost is one timestamp comparison per call. The benefit: no background work, no timer to leak, transitions are inherently tied to actual call traffic.

`getState()` does the same lazy check but **without mutating** — it lets monitoring code observe `"half-open"` once the cooldown has elapsed, even before any caller has actually probed. State only changes on `execute()`.

---

## Concurrency during half-open — the `halfOpenInFlight` flag

The half-open contract is "exactly one test request." Without a guard, this is broken under concurrency: two callers arrive at the same moment after cooldown, both flip to half-open, both fire calls against the still-broken upstream — defeating the purpose of probing.

```typescript
if (this.state === "half-open") {
  if (this.halfOpenInFlight) {
    throw new CircuitOpenError("circuit breaker is half-open — test request already in flight");
  }
  this.halfOpenInFlight = true;
}
```

This guard works in single-threaded Node because there's no preemption between `if (halfOpenInFlight)` and `halfOpenInFlight = true` — both happen synchronously before the next `await`. **In a multi-threaded runtime you'd need an atomic CAS instead.** It's reset in `finally` regardless of outcome.

---

## What counts as a failure?

This implementation counts **any rejection** from the wrapped function. That's deliberately broad. In practice you almost always want narrower semantics:

```typescript
// Don't count 4xx as upstream failure — those are caller errors
new CircuitBreaker(
  async () => {
    const res = await fetch(url);
    if (res.status >= 500) throw new Error(`upstream ${res.status}`);
    return res;   // 2xx / 3xx / 4xx all "succeed" from the breaker's view
  },
  { failureThreshold: 5, cooldownMs: 10_000 }
);
```

The breaker only knows what the wrapped function tells it. Inside `fn`, decide what's a failure (5xx, network errors, timeouts) and what isn't (4xx, expected business errors). Throw for the first category, return normally for the second.

---

## Tuning `failureThreshold` and `cooldownMs`

- **`failureThreshold` too low** (e.g. 1) — a single flaky request opens the circuit and blocks legitimate traffic. Bad for noisy environments.
- **`failureThreshold` too high** (e.g. 100) — the breaker won't trip in time to protect the upstream during a real outage.
- **`cooldownMs` too short** — you'll probe an upstream that hasn't had time to recover, get rejected again, and oscillate.
- **`cooldownMs` too long** — you'll keep rejecting locally long after the upstream has recovered.

Reasonable starting point for a typical HTTP service: `failureThreshold: 5`, `cooldownMs: 10_000`. Then tune with real failure rate and recovery time data.

A more sophisticated version uses a **sliding window** (e.g. "5 failures out of the last 20 calls") rather than consecutive failures — see the extensions section.

---

## Composing with retries

The "retry with circuit breaker" pattern is the breaker *outside* the retry loop, not inside:

```typescript
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Don't retry if the circuit is open — back off and let it heal
      if (err instanceof CircuitOpenError) throw err;
      await delay(2 ** i * 100); // exponential backoff
    }
  }
  throw lastErr;
}

const breaker = new CircuitBreaker(callUpstream, { failureThreshold: 5, cooldownMs: 10_000 });
const result = await withRetry(() => breaker.execute());
```

- Retries are for **transient** failures (one-off network blip).
- The breaker is for **sustained** failures (the upstream is genuinely down).
- Retrying *through* an open breaker just wastes time — bail out immediately on `CircuitOpenError`.

If you put the breaker *inside* the retry loop, each retry counts as a separate breaker call and inflates the failure count artificially.

---

## Composing with timeouts

A common refinement: combine with a timeout so a hung call also counts as a failure.

```typescript
function withTimeout<T>(fn: () => Promise<T>, ms: number): () => Promise<T> {
  return () =>
    Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
    ]);
}

const breaker = new CircuitBreaker(
  withTimeout(callUpstream, 2_000),
  { failureThreshold: 5, cooldownMs: 10_000 }
);
```

Without a timeout, a hung upstream can hold a slot open indefinitely without ever surfacing as a failure to the breaker.

---

## Comparison with related patterns

| Pattern | Bounds | Use when |
|---|---|---|
| `CircuitBreaker` | calls to an unreliable upstream | upstream may be down for extended periods; you want fast-fail |
| `RateLimitedFetcher` | requests/sec + concurrency | upstream is healthy but has limits you must respect |
| `TTLCache` | computation cost over time | hot reads of the same data; staleness up to TTL is OK |
| `processWithConcurrency` | concurrent fan-out | many items, one function, bounded parallelism |

Circuit breakers and retries are **defensive** patterns (about handling failure). Rate limiters and concurrency caps are **respectful** patterns (about not overloading healthy systems). Most production stacks use all four together.

---

## Edge cases worth knowing

- **Cooldown of 0** — first failure in open state immediately transitions to half-open on the next call. Effectively no cooldown; the breaker just blocks concurrent piling.
- **`failureThreshold` of 1** — single failure opens the circuit. Fragile under flaky-but-mostly-OK upstreams.
- **Long-running call straddles the cooldown** — the call started in `closed`, finishes after the cooldown elapsed. Its outcome is still applied to the current state. If it succeeds, state stays closed; if it fails, failure count increments.
- **Success while still in `closed` but with prior failures** — the failure count is reset to zero. This is "consecutive failure" semantics; for "failure rate in a window" you'd track timestamps instead.
- **`execute` called after `state` became `open` but before cooldown** — synchronously rejects with `CircuitOpenError` without invoking the wrapped function. No microtask, no I/O.
- **Concurrent half-open probes** — only one gets through (`halfOpenInFlight` guard). Others reject with `CircuitOpenError`. They'll see a definitive `closed`/`open` state on their next attempt.

---

## What this pattern is NOT

### ❌ Not a retry framework

A single failed `execute()` does not retry. Wrap with a retry helper (see "Composing with retries" above).

### ❌ Not a rate limiter

It does not cap requests/sec or in-flight count. A healthy upstream under closed state will receive every call you submit.

### ❌ Not a window-based breaker

Failures are counted as **consecutive**. A success resets the count to zero. If you have a 95%-success upstream and want "trip if failure rate over the last N calls exceeds 50%," you'd swap the counter for a sliding-window structure (ring buffer of recent outcomes, or time-bucketed counters).

### ❌ Not distributed

State is in-process. Two pods each run their own breaker independently — one's open state doesn't propagate. For shared health signals across a fleet, you typically push the breaker into a service mesh / sidecar (Envoy, Istio).

### ❌ Not a panacea for cascading failures

A breaker around one dependency stops *that* call from hanging. It doesn't help if many of your dependencies fail simultaneously and your overall throughput collapses. Pair with bulkheads (per-dependency concurrency caps) and timeouts for full coverage.

---

## TL;DR

- State machine: **closed → open → half-open → closed/open**, transitioned lazily on `execute()`.
- `failureThreshold` consecutive failures trip closed → open.
- After `cooldownMs`, next call goes through as a half-open **test** (exactly one in flight at a time).
- Test success → closed (full reset). Test failure → open (cooldown restarts).
- `CircuitOpenError` is the short-circuit signal — catch it to fall back, don't retry through it.
- In-process, single-instance; broaden via service mesh or shared store if needed.
