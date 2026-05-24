export interface RateLimitedFetcherOptions {
  maxConcurrent: number;
  maxPerSecond: number;
}

export class RateLimitedFetcher {
  private maxConcurrent: number;
  private maxPerSecond: number;
  private activeConcurrent = 0;
  private timestamps: number[] = [];
  private queue: Array<() => void> = [];

  constructor(options: RateLimitedFetcherOptions) {
    this.maxConcurrent = options.maxConcurrent;
    this.maxPerSecond = options.maxPerSecond;
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    await this.acquireSlot();

    try {
      return await globalThis.fetch(url, init);
    } finally {
      this.activeConcurrent -= 1;
      this.releaseNextWaiter();
    }
  }

  private acquireSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.tryAcquireNow()) {
        resolve();
      } else {
        this.queue.push(resolve);
        this.scheduleRateWakeupIfNeeded();
      }
    });
  }

  private tryAcquireNow(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => t > now - 1000);

    if (
      this.activeConcurrent < this.maxConcurrent &&
      this.timestamps.length < this.maxPerSecond
    ) {
      this.activeConcurrent += 1;
      this.timestamps.push(now);
      return true;
    }
    return false;
  }

  // Only useful when we're rate-blocked but have concurrency budget —
  // otherwise the next `finally` will call releaseNextWaiter() for us.
  private scheduleRateWakeupIfNeeded(): void {
    if (
      this.activeConcurrent < this.maxConcurrent &&
      this.timestamps.length > 0
    ) {
      const oldest = this.timestamps[0]!;
      const waitMs = oldest + 1000 - Date.now() + 1;
      setTimeout(() => this.releaseNextWaiter(), waitMs);
    }
  }

  private releaseNextWaiter(): void {
    if (this.queue.length === 0) return;

    if (this.tryAcquireNow()) {
      const resolve = this.queue.shift()!;
      resolve();
    } else {
      this.scheduleRateWakeupIfNeeded();
    }
  }
}
