export type FetchFn<T> = (key: string) => Promise<T>;

export interface TTLCacheOptions {
  ttlMs: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private inFlight = new Map<string, Promise<T>>();
  private fetchFn: FetchFn<T>;
  private ttlMs: number;

  constructor(fetchFn: FetchFn<T>, options: TTLCacheOptions) {
    this.fetchFn = fetchFn;
    this.ttlMs = options.ttlMs;
  }

  async get(key: string): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const fetchPromise = this.fetchAndCache(key);
    this.inFlight.set(key, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  private async fetchAndCache(key: string): Promise<T> {
    const value = await this.fetchFn(key);
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }
}
