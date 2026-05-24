type BatchFn<T, R> = (items: T[]) => Promise<(R | Error)[]>;

interface MicroBatcherOptions {
  maxBatchSize: number;
  maxWaitMs: number;
}

interface QueueEntry<T, R> {
  item: T;
  resolve: (value: R) => void;
  reject: (error: Error) => void;
}

export class MicroBatcher<T, R> {
  private queue: QueueEntry<T, R>[] = [];
  private timer: NodeJS.Timeout | null = null;
  private batchFn: BatchFn<T, R>;
  private maxBatchSize: number;
  private maxWaitMs: number;
  private isShutdown = false;

  constructor(batchFn: BatchFn<T, R>, options: MicroBatcherOptions) {
    this.batchFn = batchFn;
    this.maxBatchSize = options.maxBatchSize;
    this.maxWaitMs = options.maxWaitMs;
  }

  submit(item: T): Promise<R> {
    if (this.isShutdown) {
      return Promise.reject(new Error('MicroBatcher has been shut down'));
    }

    return new Promise<R>((resolve, reject) => {
      this.queue.push({ item, resolve, reject });

      if (this.queue.length >= this.maxBatchSize) {
        // Batch is full — flush immediately
        this.flush();
      } else if (!this.timer) {
        // Start the timer on first item in a new batch
        this.timer = setTimeout(() => this.flush(), this.maxWaitMs);
      }
    });
  }

  private async flush(): Promise<void> {
    // Clear the timer
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) return;

    // Take the current batch out of the queue
    const batch = this.queue.splice(0, this.maxBatchSize);
    const items = batch.map((entry) => entry.item);

    try {
      const results = await this.batchFn(items);

      // Contract: batchFn must return exactly one result (or Error) per item.
      // A length mismatch is a programmer error — reject the whole batch.
      if (results.length !== batch.length) {
        const err = new Error(
          `batchFn contract violation: expected ${batch.length} results, got ${results.length}`,
        );
        batch.forEach((entry) => entry.reject(err));
      } else {
        batch.forEach((entry, index) => {
          const result = results[index]!;
          if (result instanceof Error) {
            entry.reject(result);
          } else {
            entry.resolve(result);
          }
        });
      }
    } catch (error) {
      // batchFn itself threw — reject ALL promises in this batch
      batch.forEach((entry) => {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      });
    }

    // If there are leftover items (queue > maxBatchSize), flush again
    if (this.queue.length > 0) {
      this.flush();
    }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    await this.flush();
  }
}

