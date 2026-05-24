# async-typescript-patterns

Reference implementations of the async patterns that come up over and over in pair-coding interviews and real production code — each in its own folder under [services/](services/) with `service.ts`, `service.test.ts`, and a `usage.md` that explains the *why*.

Patterns:
- [micro-batcher](services/micro-batcher/) — coalesce many individual calls into one bulk operation
- [bounded-concurrency-processor](services/bounded-concurrency-processor/) — worker-pool fan-out with a max in-flight cap
- [rate-limited-fetcher](services/rate-limited-fetcher/) — concurrency + requests-per-second budget
- [prioritised-job-scheduler](services/prioritised-job-scheduler/) — strict priority + FIFO within level
- [concurrent-scanner](services/concurrent-scanner/) — run independent checks in parallel with per-check timeouts
- [cache](services/cache/) — TTL cache with thundering-herd request dedup
- [retry](services/retry/) — circuit breaker (closed / open / half-open)
- [lock](services/lock/) — Mutex + KeyedMutex for serialising async critical sections

Stack: TypeScript + Jest. Run `npm install` then `npx jest`.
