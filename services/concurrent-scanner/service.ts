export type CheckFn<D> = (target: string) => Promise<D>;

export type CheckResult<D> =
  | { status: "passed"; data: D }
  | { status: "error"; error: string };

export interface ScanReport<C extends Record<string, CheckFn<unknown>>> {
  target: string;
  results: { [K in keyof C]: CheckResult<Awaited<ReturnType<C[K]>>> };
  scannedAt: Date;
}

export interface DomainScannerOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class DomainScanner<C extends Record<string, CheckFn<unknown>>> {
  private checks: C;
  private timeoutMs: number;

  constructor(checks: C, options: DomainScannerOptions = {}) {
    this.checks = checks;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async scan(target: string): Promise<ScanReport<C>> {
    const names = Object.keys(this.checks) as Array<keyof C>;

    const settled = await Promise.allSettled(
      names.map((name) => this.runCheck(name as string, target))
    );

    const results = {} as ScanReport<C>["results"];

    settled.forEach((outcome, index) => {
      const name = names[index]!;
      if (outcome.status === "fulfilled") {
        results[name] = {
          status: "passed",
          data: outcome.value as Awaited<ReturnType<C[typeof name]>>
        };
      } else {
        results[name] = {
          status: "error",
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        };
      }
    });

    return { target, results, scannedAt: new Date() };
  }

  private async runCheck(name: string, target: string): Promise<unknown> {
    const fn = this.checks[name]!;

    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`check "${name}" timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs
      );
    });

    try {
      return await Promise.race([fn(target), timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}
