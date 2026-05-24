export type Priority = "high" | "medium" | "low";

const PRIORITY_ORDER: Priority[] = ["high", "medium", "low"];

export interface JobExecutor<T, R> {
  execute(job: T): Promise<R>;
}

export interface PrioritisedJobSchedulerOptions {
  maxConcurrent: number;
}

interface QueueEntry<T, R> {
  job: T;
  resolve: (value: R) => void;
  reject: (error: Error) => void;
}

export class PrioritisedJobScheduler<T, R> {
  private executor: JobExecutor<T, R>;
  private maxConcurrent: number;
  private active = 0;
  private queues: Record<Priority, QueueEntry<T, R>[]> = {
    high: [],
    medium: [],
    low: []
  };

  constructor(executor: JobExecutor<T, R>, options: PrioritisedJobSchedulerOptions) {
    this.executor = executor;
    this.maxConcurrent = options.maxConcurrent;
  }

  submit(job: T, priority: Priority): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.queues[priority].push({ job, resolve, reject });
      this.tryDispatch();
    });
  }

  private tryDispatch(): void {
    while (this.active < this.maxConcurrent) {
      const item = this.dequeueHighest();
      if (!item) return;
      this.active += 1;
      this.run(item);
    }
  }

  private dequeueHighest(): QueueEntry<T, R> | undefined {
    for (const p of PRIORITY_ORDER) {
      const entry = this.queues[p].shift();
      if (entry) return entry;
    }
    return undefined;
  }

  private async run(entry: QueueEntry<T, R>): Promise<void> {
    try {
      const value = await this.executor.execute(entry.job);
      entry.resolve(value);
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.active -= 1;
    this.tryDispatch();
  }
}
