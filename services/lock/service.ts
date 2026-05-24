export type ReleaseFn = () => void;

export class Mutex {
  // The chain is a never-rejecting Promise<void> that resolves when the lock is free.
  // Each acquire() captures the current chain (its "wait") and replaces it with a new
  // unresolved promise (its "release"). The next acquirer waits on that.
  private chain: Promise<void> = Promise.resolve();
  private waiterCount = 0;

  isLocked(): boolean {
    return this.waiterCount > 0;
  }

  async acquire(): Promise<ReleaseFn> {
    this.waiterCount += 1;

    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    const previous = this.chain;
    this.chain = next;

    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.waiterCount -= 1;
      release();
    };
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class KeyedMutex<K = string> {
  private locks = new Map<K, Mutex>();

  isLocked(key: K): boolean {
    return this.locks.get(key)?.isLocked() ?? false;
  }

  async withLock<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const lock = this.getOrCreate(key);
    try {
      return await lock.withLock(fn);
    } finally {
      // Drop the per-key Mutex once no one is holding or waiting on it,
      // so the map doesn't grow unboundedly over the keyspace.
      if (!lock.isLocked() && this.locks.get(key) === lock) {
        this.locks.delete(key);
      }
    }
  }

  private getOrCreate(key: K): Mutex {
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(key, lock);
    }
    return lock;
  }
}
