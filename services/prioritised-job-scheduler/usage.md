# Prioritised Job Scheduler Usage

## What problem it solves

You have a stream of jobs of mixed importance flowing into a downstream system with a hard concurrency limit (e.g. "no more than 10 in-flight requests"). When the limit is hit, work queues — and you want **important work to skip the line**.

Concrete examples:

- A payments API: "Checkout" jobs are revenue-critical and customer-facing; "Profile sync" jobs are batch background work. When the API is saturated, checkouts must go through first.
- A model inference service: interactive requests (user typing) vs. embedding-refresh jobs (overnight). Both go to the same model; interactive should win.
- A CRM webhook listener: account-deletion webhooks (compliance-critical) vs. activity-sync webhooks (analytics).

The scheduler enforces two invariants:

1. **Concurrency cap** — never run more than `maxConcurrent` jobs simultaneously.
2. **Priority order** — among waiting jobs, always start the highest-priority one next. FIFO within the same priority level.

This is essentially a **counting semaphore with a priority-aware waiter queue** — same shape as the rate-limited fetcher, just with a different ordering policy for the queue.

---

## Basic usage

The scheduler is decoupled from execution. You hand it a `JobExecutor` — an object whose `execute(job)` knows how to actually run one job. The scheduler does the scheduling; the executor does the work.

```typescript
import { PrioritisedJobScheduler, JobExecutor } from './service';

interface PaymentJob {
  customerId: string;
  amount: number;
  endpoint: string;
}

interface PaymentResult {
  transactionId: string;
}

class PaymentApiExecutor implements JobExecutor<PaymentJob, PaymentResult> {
  async execute(job: PaymentJob): Promise<PaymentResult> {
    const res = await fetch(job.endpoint, {
      method: 'POST',
      body: JSON.stringify({ customerId: job.customerId, amount: job.amount }),
    });
    if (!res.ok) throw new Error(`payment failed: ${res.status}`);
    return res.json();
  }
}

const scheduler = new PrioritisedJobScheduler(new PaymentApiExecutor(), {
  maxConcurrent: 10,
});

// Anywhere in the app:
const result = await scheduler.submit(
  { customerId: 'c123', amount: 100, endpoint: '/charge' },
  'high',          // checkout — high priority
);

// Background profile sync — low priority
await scheduler.submit(
  { customerId: 'c456', amount: 0, endpoint: '/sync' },
  'low',
);
```

`submit()` returns a Promise that resolves with whatever `execute()` returned, or rejects with whatever it threw.

---

## How priorities actually work

Three levels: `'high'`, `'medium'`, `'low'`. The dispatcher's rule when a slot opens:

1. Pop from `high` if non-empty.
2. Else pop from `medium` if non-empty.
3. Else pop from `low`.

Within a level, it's FIFO (oldest submission wins). Strict priority + first-come-first-served at the same level.

```
maxConcurrent = 2
slots: [running, running]
       ┌── high   ──┐
queue: │ medium = [M1, M2]   │
       │ low    = [L1]       │
       └────────────┘

A running job finishes → dispatcher pops M1 first
                       (medium is highest non-empty)
A running job finishes → dispatcher pops M2
A running job finishes → dispatcher pops L1
```

If a high-priority job arrives while M1 is queued:

```
queue before: high=[], medium=[M1, M2], low=[L1]
submit(H1, 'high')
queue after:  high=[H1], medium=[M1, M2], low=[L1]

Next dispatch will pop H1 — even though M1 was submitted earlier.
```

**No preemption.** Running jobs are never interrupted. Priority decides *next-to-start*, not *currently-running*.

---

## The starvation tradeoff

Strict priority can starve lower-priority work if higher-priority work arrives faster than it drains. With `maxConcurrent: 10` and a constant stream of `high` jobs at exactly 10/sec, `low` jobs will never run.

For this problem statement, that's the desired behaviour — checkout should always beat profile-sync, even if it means profile-sync waits. If you ever needed weak fairness (e.g. "at least 1 low job per 100 high jobs"), you'd add an aging mechanism: bump a low job's priority based on how long it's been queued, or use a weighted round-robin instead of strict priority.

Document the policy and stick to one — mixing strict and weighted is where production bugs live.

---

## Why a `JobExecutor` interface, not just a function

You *could* take a function instead:

```typescript
new PrioritisedJobScheduler(async (job) => doWork(job), { maxConcurrent: 10 });
```

The interface form has two practical wins:

1. **Mocking in tests** is more natural — swap in a `MockExecutor` class.
2. **Dependency injection** plays nicely — the executor can hold state (an HTTP client with retries, a connection pool, metrics) and be replaced at boot time without touching scheduler internals.

The scheduler doesn't care what `execute()` does — only that it returns a Promise. You can keep it as simple as `{ execute: async (j) => fn(j) }` if you don't need a class.

---

## Comparison with the other patterns

| Pattern | Bounds | Queue policy | Use when |
|---|---|---|---|
| `processWithConcurrency` | concurrency | none — known array | one-shot fan-out over a known list |
| `RateLimitedFetcher` | concurrency + rate/sec | FIFO | long-lived limiter for a single upstream |
| `PrioritisedJobScheduler` | concurrency | **priority + FIFO within level** | stream of mixed-importance work against a capped backend |
| `MicroBatcher` | batch size + max wait | n/a — bulk dispatch | callers want one-by-one API but downstream has a bulk endpoint |

They compose:

```typescript
// Stack: scheduler → rate-limited fetcher → real API
const apiFetcher = new RateLimitedFetcher({ maxConcurrent: 10, maxPerSecond: 50 });

class ApiExecutor implements JobExecutor<Job, Result> {
  async execute(job: Job): Promise<Result> {
    const res = await apiFetcher.fetch(job.url, job.init);   // shared limiter
    return res.json();
  }
}

const scheduler = new PrioritisedJobScheduler(new ApiExecutor(), { maxConcurrent: 10 });
```

The scheduler decides *which* job runs next; the rate-limited fetcher enforces the per-second cap on the actual HTTP call. Each layer has one concern.

---

## Edge cases worth knowing

- **No preemption.** A long-running `low` job that started before any `high` arrives will not be interrupted. The `high` waits behind it for that slot to free.
- **Starvation under sustained high-priority load.** Strict priority by design — see the tradeoff section above.
- **Executor throws synchronously?** TypeScript's `async` wraps the throw into a rejection, so the scheduler's `try/catch` still works. If you pass a non-async function that throws, you'd need to wrap it.
- **Hung executor.** A job that never resolves holds its slot forever. Combine with a timeout inside the executor if you need hard ceilings.
- **Submit while running at capacity.** The Promise stays pending; nothing else differs.
- **No backpressure on the queue.** If submissions come in faster than execution, the priority queues grow unboundedly. In production, add a `maxQueueSize` (per-priority or total) and reject `submit()` when exceeded.

---

## What this pattern is NOT

### ❌ Not a retry framework

If `execute()` rejects, the scheduler reports that failure to the submitter. It does not retry. Layer retries inside the executor if you want them.

### ❌ Not preemptive

Running work is never cancelled. If you need true preemption (rare), pass an `AbortSignal` into the executor and call `.abort()` from outside.

### ❌ Not distributed

In-process state only. Two pods running this code each get their own queue — they don't coordinate. For shared queue + priority across a fleet, you need a real broker (Redis ZSET as a priority queue, RabbitMQ priority queues, SQS with explicit priority partitions, etc.).

### ❌ Not a rate limiter

It caps **in-flight count**, not **requests per second**. If the downstream needs both, stack a `RateLimitedFetcher` inside the executor.

---

## TL;DR

- Counting semaphore + priority-aware waiter queue.
- `submit(job, priority)` returns a Promise; resolves with executor output, rejects with executor errors.
- Strict priority across levels, FIFO within a level. No preemption.
- Decoupled from execution via `JobExecutor` — pluggable for testing, DI, and composition.
- Starvation of lower priorities is possible by design; add aging only if your domain needs weak fairness.
