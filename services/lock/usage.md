# Mutex / KeyedMutex Usage

## What problem it solves

"JavaScript is single-threaded so you don't need locks." That's a half-truth that bites people in production.

**True:** there's no *preemption mid-statement*. A line like `balance -= amount` can't be interrupted halfway through. There's no torn read.

**False:** there is preemption **at every `await`**. Any function that awaits can be paused, letting other Promise continuations run, who can read and mutate the same shared state, and then yield back. The hazard is not the CPU instruction — it's the **logical check-then-act** that spans an `await`.

```typescript
// Hazard: shared state read BEFORE await, mutated AFTER
let balance = 100;

async function withdraw(amount: number): Promise<boolean> {
  if (balance >= amount) {          // read
    await processPayment(amount);   // ◄── yield point: anyone else can also pass the check
    balance -= amount;              // mutate
    return true;
  }
  return false;
}

await Promise.all([withdraw(75), withdraw(75)]);
// Both pass `balance >= 75`, both call processPayment, both subtract → balance = -50.
```

A mutex is the standard fix: serialise the critical section so only one async task is **logically inside** it at a time. The work still all happens on one OS thread; what the mutex prevents is *interleaving at await points*.

---

## Basic usage — `withLock`

```typescript
import { Mutex } from "./service";

const lock = new Mutex();
let balance = 100;

async function withdraw(amount: number): Promise<boolean> {
  return lock.withLock(async () => {
    if (balance >= amount) {
      await processPayment(amount);
      balance -= amount;
      return true;
    }
    return false;
  });
}

await Promise.all([withdraw(75), withdraw(75)]);
// Exactly one succeeds. Balance is 25.
```

`withLock(fn)` is the API you should reach for 95% of the time. It:

1. Acquires the lock (awaiting if necessary).
2. Runs your function.
3. Releases the lock in a `finally` — **even if `fn` throws**.
4. Resolves/rejects with `fn`'s outcome.

Forgetting to release a lock is the cardinal sin of locking; `withLock` makes it impossible.

---

## The escape hatch — manual `acquire()`

Sometimes you can't wrap the critical section in a callback (state spans multiple methods, e.g. a transaction-like flow with a separate `commit()` / `rollback()`). Use the manual API:

```typescript
const release = await lock.acquire();
try {
  // ... critical section spanning multiple steps ...
} finally {
  release();   // ALWAYS release, no matter what
}
```

The release function is **idempotent** — calling it twice is a no-op. That's defensive against accidental double-calls in tangled `finally` blocks.

If you find yourself reaching for this often, your critical section is probably doing too much. Prefer `withLock`.

---

## How it works under the hood — the Promise chain

The lock is a **never-rejecting chain of Promises**:

```
chain ──► P0 (resolved)
                │
        acquire by A
                │
chain ──► PA (unresolved — resolves when A releases)
                │
        acquire by B
                │
chain ──► PB (unresolved — resolves when B releases)
```

Each `acquire()`:

1. Snapshots the current chain (`previous`) — this is "what I'm waiting on."
2. Creates a new unresolved Promise (`next`) and overwrites the chain with it — this is "what the next acquirer will wait on."
3. Awaits `previous`. When it resolves, the lock is free. Returns a release function that, when called, resolves `next` — letting the next acquirer through.

The chain is intentionally a `Promise<void>` that **only resolves, never rejects**. Errors from the user's `fn` are caught and re-thrown by `withLock` *after* releasing; they don't poison the chain. This is the bug in the naïve `let lock = lock.then(fn)` pattern from the prep doc — a thrown error becomes a rejected chain, and every subsequent caller's `.then(...)` inherits the rejection.

---

## Why the global `let lock = Promise.resolve()` pattern is brittle

You'll see this pattern in many tutorials:

```typescript
let lock = Promise.resolve();

function withdraw(amount: number): Promise<boolean> {
  const result = lock.then(async () => { /* critical section */ });
  lock = result.then(() => {});
  return result;
}
```

Problems:

1. **One global lock per file.** Two unrelated resources sharing this lock serialise against each other for no reason.
2. **Errors poison the chain.** If `result` rejects, `lock` becomes a rejected Promise (via `.then(() => {})` which doesn't handle errors). Every subsequent withdraw rejects with the original error.
3. **No introspection.** Can't check "is the lock held?" without bolting on more state.
4. **No keyed variant.** Per-resource serialisation requires manually maintaining `Map<key, Promise>`.
5. **Hard to read.** "What is the lock holding right now?" requires understanding Promise chaining mentally.

`Mutex` packages the same idea into a class with proper error handling, isolation, and a sane API.

---

## Per-resource serialisation — `KeyedMutex`

A single global lock serialises **everything** through one point — usually overkill, sometimes a bottleneck.

Real-world serialisation is almost always per-resource:

- "Don't process two charges for the same **order** simultaneously" — lock per order ID.
- "Refresh this user's token only once at a time" — lock per user ID.
- "Don't write to the same file from two callers" — lock per file path.

`KeyedMutex<K>` gives you that:

```typescript
import { KeyedMutex } from "./service";

const lock = new KeyedMutex<string>();

async function chargeOrder(orderId: string, amount: number) {
  return lock.withLock(orderId, async () => {
    // Only one charge per orderId at a time.
    // Different orderIds run fully concurrently.
    await db.charge(orderId, amount);
  });
}

// Concurrent calls — same order serialised, different orders parallel
await Promise.all([
  chargeOrder("order-1", 50),
  chargeOrder("order-1", 30),   // waits for the previous one
  chargeOrder("order-2", 99)    // runs immediately, parallel to order-1
]);
```

Memory: each unique key gets its own `Mutex`. When a key's lock becomes idle (no holder, no waiters), the `KeyedMutex` deletes it from its internal map so the map doesn't grow with every key ever seen. The next call for that key creates a fresh `Mutex` — which is fine, because the contract is "one critical section per key at a time," not "the same lock instance."

---

## Comparison with related patterns

| Pattern | What it serialises | When you'd reach for it |
|---|---|---|
| `Mutex` | one critical section globally | shared mutable state in a single module/object |
| `KeyedMutex<K>` | per-key critical sections | per-resource (per-user, per-order, per-file) serialisation |
| `processWithConcurrency` | how many run at once (N, not 1) | bounded parallelism, no exclusivity per item |
| `RateLimitedFetcher` | requests/sec + in-flight count | rate-limited external calls; not about your shared state |
| `MicroBatcher` | n/a — coalescing | many callers wanting the same kind of bulk operation |

A mutex is the right tool when the constraint is **"at most one at a time touching this state."** If the constraint is "at most N at a time," you want concurrency control instead.

---

## Composing with other patterns

**`KeyedMutex` + `TTLCache` for safe write-through caches.** A cache's `set` is racy on its own (two writers can clobber each other's update); guard it with a per-key lock.

```typescript
import { KeyedMutex } from "../lock/service";
import { TTLCache } from "../cache/service";

const writeLock = new KeyedMutex<string>();
const cache = new TTLCache(loadUser, { ttlMs: 60_000 });

async function updateUser(id: string, patch: Partial<User>) {
  return writeLock.withLock(id, async () => {
    const user = await cache.get(id);
    const updated = { ...user, ...patch };
    await db.users.update(id, updated);
    cache.invalidate(id); // next read re-fetches the canonical value
    return updated;
  });
}
```

**`Mutex` inside an executor that mutates shared scheduler state.** If your `JobExecutor` for the `PrioritisedJobScheduler` touches a shared counter or stats object, a mutex inside `execute()` prevents two concurrent jobs from clobbering it.

---

## Edge cases worth knowing

- **`fn` throws** — the lock is released, the rejection propagates. The next acquirer is unaffected.
- **Multiple awaits inside `fn`** — fine. The whole `fn` body runs to completion (success or error) before the lock is released. Other acquirers wait for the entire body, not just the first await.
- **`fn` never resolves** — the lock is held forever. There's no built-in timeout; if you need one, wrap `fn` with a `Promise.race(fn(), timeout)` and let the timeout reject.
- **Double-release** — idempotent, no effect. Helpful when defensive `finally` chains call `release()` more than once.
- **Acquire called from inside a held critical section (re-entrancy)** — this **deadlocks**. The Mutex is **not re-entrant**: it has no concept of "the current holder is already me." If you need to call helper functions that also acquire the lock, refactor to call the un-locked version, or don't lock the helper.
- **Lots of unique keys in `KeyedMutex`** — entries are evicted as they go idle, so cardinality at rest is bounded by what's actively contended. Burst keyspaces are fine.

---

## What this pattern is NOT

### ❌ Not a re-entrant mutex

If a code path that's already holding the lock tries to acquire it again, it deadlocks (waits for itself). If you need re-entrancy, track the holder with a per-task identifier (e.g. AsyncLocalStorage in Node) and let the same task reuse the lock.

### ❌ Not a read/write lock

Both readers and writers are treated identically — only one at a time. If you have a high-read / low-write workload and reads can be safely parallel, you want a `RWMutex` (allows N readers OR 1 writer).

### ❌ Not distributed

In-process state. Two pods each have their own Mutex; they don't coordinate. For cross-process exclusivity, you need a distributed lock (Redis with `SET NX PX`, Zookeeper, etcd, DB row locks, etc.). Pay attention to fencing tokens to handle pauses and lease expiries.

### ❌ Not a substitute for transactions

If your "critical section" is a multi-step database update that needs all-or-nothing semantics, that's a transaction problem. A mutex only prevents concurrent JS execution; it doesn't roll back partial work on failure.

### ❌ Not free

Every locked section is a serialisation point. Overuse turns parallel workloads into single-file queues. Lock only what's truly shared; prefer immutable data passed by value where you can.

---

## TL;DR

- JS is single-threaded but `await` is a yield point — shared state across an `await` is a race.
- `Mutex.withLock(fn)` serialises `fn` against itself; always releases (even on throw); FIFO order.
- `acquire()` returns an idempotent release function for the escape-hatch case.
- `KeyedMutex<K>.withLock(key, fn)` serialises per-key; different keys are fully parallel; idle keys are evicted.
- Not re-entrant, not a RWLock, not distributed, not a transaction. Use the right tool for each.
