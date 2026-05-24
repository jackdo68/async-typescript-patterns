# Promise Recap — The Write Side / Read Side Model

A mental model for how Promises actually work — specifically, how the MicroBatcher (and patterns like it) exploit the fact that a Promise can be **split across time**.

---

## The common misconception

Most people describe Promises like this:

> "`resolve` and `reject` are two callbacks that get executed when the promise is fulfilled."
> "When the promise fulfills, one of the callbacks gets triggered."

That phrasing has the **directionality backwards**. Let's fix it.

The promise doesn't fulfill *and then* call resolve. **Calling `resolve()` is what *causes* the promise to fulfill.** Same for `reject` → rejection.

`resolve` / `reject` are the **cause**, not the **effect**.

---

## The two sides of a Promise

The clearest way to think about it:

```
        ┌─────────── PROMISE ───────────┐
        │                               │
WRITE   │  resolve(value)               │   READ
side    │  reject(error)                │   side
        │                               │
        │     ── shared state ──        │
        │                               │
        │       .then(onFulfilled)      │
        │       .catch(onRejected)      │
        │       await                   │
        └───────────────────────────────┘
```

- **Write side** (`resolve` / `reject`): the *cause*. You call these to **set the outcome**. The batcher keeps these.
- **Read side** (`.then` / `.catch` / `await`): the *effect*. You attach these to **be notified when the outcome arrives**. The caller uses these.

The Promise constructor is the moment those two sides are wired together.

```typescript
new Promise((resolve, reject) => {
  //         ↑ WRITE SIDE — exposed only to the executor function
});
// ↑ READ SIDE — the Promise object the constructor returns
```

The executor function `(resolve, reject) => { ... }` hands you the write side. Whatever object `new Promise(...)` returns is the read side. **They share the same internal state machine.**

---

## The pointer metaphor — almost right, but not quite

A natural intuition is "the Promise in memory is a pointer to the two callbacks." That's not quite right.

The Promise object the caller receives does **not** expose `resolve` / `reject`. It only exposes `.then` / `.catch` / `.finally` — the read side. The `resolve` and `reject` closures are captured inside the executor function. Only code that runs inside `new Promise((resolve, reject) => { ... })` ever sees them.

That's the whole trick: by capturing those closures and saving them somewhere (e.g., a queue), you can **split the Promise across time**. One side holds the read end; another side holds the write end; they meet again later when someone calls `resolve` / `reject`.

This pattern has a name: a **"deferred"**. You'll see it called that in older codebases (jQuery's `$.Deferred()`, Q's `Q.defer()`). Modern JavaScript uses the Promise constructor pattern but the concept is identical.

---

## How MicroBatcher exploits this

```typescript
// In MicroBatcher.submit:
return new Promise<R>((resolve, reject) => {
  //                    ↑ WRITE SIDE — batcher captures these into the queue
  this.queue.push({ item, resolve, reject });
});
// ↑ READ SIDE — this Promise object goes to the caller
```

The submit method:

1. Creates a fresh Promise.
2. Inside the executor, stashes `resolve` / `reject` into the queue alongside the item.
3. Returns the Promise (read side) to the caller.

The Promise is **pending** at this point. No outcome has been written yet. The caller will `await` it; they're suspended until someone calls `resolve` or `reject`.

Later, when `flush()` runs and `batchFn` returns results:

```typescript
batch.forEach((entry, index) => {
  entry.resolve(results[index]!);  // ← CAUSES the caller's await to unblock
});
```

This is the moment the two sides meet again. The write happens; the read side delivers the value to whoever was awaiting.

---

## The full flow, step by step

```
1. Caller calls batcher.submit("example.com")

2. Batcher creates `new Promise(...)`
   ├── resolve/reject (write side)    → stored in queue with the item
   └── Promise object (read side)     → returned to the caller

3. Caller does `await promise`
   └── This registers a "wake me up when settled" hook on the read side.
       Caller is now suspended.

4. Time passes. More submits happen. Timer or size threshold fires.

5. Batcher calls `flush()` → calls `batchFn(items)` → gets results.

6. For each entry, batcher calls `entry.resolve(result)`.
   ↑ THIS IS THE CAUSE OF FULFILLMENT.
   Calling resolve() flips the promise from "pending" to "fulfilled"
   AND wakes up anyone awaiting it.

7. The caller's `await` unblocks with the value.
```

---

## The corrected phrasing

❌ "resolve and reject are two callbacks that will be executed when the promise is fulfilled"

✅ "`resolve` and `reject` are two callbacks that the batcher **calls to make the promise fulfill or reject**. When the caller `await`s the promise returned by `submit()`, they're suspended until the batcher invokes one of those callbacks. From the service's perspective, for each entry we store the pair of callbacks so we can invoke them later in `flush()`."

---

## The return-addressed envelope analogy

Each `QueueEntry` is like a return-addressed envelope:

| Field | Real-world analogy |
|---|---|
| `item` | The letter you're sending |
| `resolve` | The return address for "delivered successfully" |
| `reject` | The return address for "delivery failed" |

The batcher collects N envelopes, sends them all in one truck (`batchFn`), then when the truck comes back it uses each envelope's return address to deliver the right outcome to the right sender.

---

## One-line mental model

> A Promise is a **shared state machine**: one side writes the outcome (`resolve` / `reject`); the other side reads it (`await`). The MicroBatcher works because it captures the write side and parks it in a queue until the batch is ready to fire.

Memorize that line. If an interviewer asks "explain how `submit()` works under the hood," that's your answer.

---

## Why this knowledge is useful beyond batching

This same "capture the write side and stash it" pattern shows up everywhere:

- **DataLoader** (Facebook) — same trick, scoped per request.
- **Request deduplication** in caches — multiple callers waiting on one in-flight fetch all share the same Promise (the read side); only one piece of code holds the write side and resolves it.
- **Event-driven RPC clients** — when you send a message and need to match a future response back to the right caller, you store `{ id, resolve, reject }` and resolve when the matching response arrives.
- **Queues and worker pools** that need to return per-item results.
- **Async semaphores and locks** — `acquire()` returns a Promise; `release()` calls the next waiter's `resolve()`.
- **WebSocket / long-polling clients** with request/response correlation IDs.

Once you see "write side / read side" as the underlying primitive, all of these patterns look like the same shape: **a Promise split across time, with the write side captured for later use.**

---

## When to call `resolve()` vs `reject()`

### Write side — which one to call

| Use | When |
|---|---|
| **`reject(err)`** | The operation couldn't reach a usable outcome (network down, contract violated, invariant broken). Async equivalent of `throw`. |
| **`resolve(value)`** | The operation reached an outcome — including expected non-happy cases. The value can be the happy result, a tagged variant, or a list with per-item failures inline. |

One-liner: **reject if you'd `throw` in a sync version; resolve otherwise.**

### Read side — how to handle each

| Write call | Read effect | Consumer code |
|---|---|---|
| `resolve(v)` | `await` returns `v` | branch on the value's shape — no `try/catch` needed |
| `reject(e)` | `await` throws `e` | `try/catch`, `.catch()`, or let it propagate |

The write-side choice dictates the read-side syntax. Pick the one that matches how callers actually want to handle the outcome.

```typescript
// reject  →  try/catch
try {
  const user = await fetchUser(id);
} catch (err) { /* network/HTTP failure */ }

// resolve with tagged variant  →  branch on shape
const r = await getCached(key);
if (r.status === 'found') use(r.value);
else                       fetchFresh(key);

// resolve with mixed array  →  iterate per-item
const results = await batchFn(items);
results.forEach((r, i) => {
  if (r instanceof Error) handleFailure(items[i], r);
  else                    handleSuccess(items[i], r);
});
```

### Two mistakes to avoid

- **Reject on every non-happy case:** a cache miss isn't a failure — forcing callers to wrap routine paths in `try/catch` is noise.
- **Resolve with `T | Error` everywhere:** callers must narrow on every `await`; forget the narrow and `.name` silently reads off an Error; `Promise.all` no longer short-circuits on real failure.

### MicroBatcher applied

- `batchFn` **resolves** with `(R | Error)[]` — the batch ran successfully; per-item failures are values.
- Each `submit()` promise **resolves or rejects** per caller — that one caller either got their item or didn't.

Two layers, two different choices — each matches what its own consumer needs to do next.

---

## TL;DR

- A Promise has two sides: **write** (`resolve`/`reject`) and **read** (`.then`/`await`).
- `resolve()` and `reject()` are the **cause** of fulfillment/rejection, not the effect.
- The Promise constructor wires the two sides together; the executor function is the only place the write side is exposed.
- By capturing the write side (storing `resolve`/`reject` somewhere), you can split a Promise across time — that's the trick MicroBatcher and many other async patterns rely on.
- This pattern is called a **"deferred"**.
- Use **`reject`** when the caller can't continue (async equivalent of `throw`); use **`resolve`** for any outcome the caller will branch on or consume — including expected non-happy results.
