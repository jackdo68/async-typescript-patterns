export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
}

export class CircuitOpenError extends Error {
  constructor(message = "circuit breaker is open") {
    super(message);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker<T> {
  private fn: () => Promise<T>;
  private failureThreshold: number;
  private cooldownMs: number;

  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private halfOpenInFlight = false;

  constructor(fn: () => Promise<T>, options: CircuitBreakerOptions) {
    this.fn = fn;
    this.failureThreshold = options.failureThreshold;
    this.cooldownMs = options.cooldownMs;
  }

  async execute(): Promise<T> {
    if (this.state === "open") {
      if (this.cooldownElapsed()) {
        this.state = "half-open";
      } else {
        throw new CircuitOpenError();
      }
    }

    if (this.state === "half-open") {
      if (this.halfOpenInFlight) {
        throw new CircuitOpenError("circuit breaker is half-open — test request already in flight");
      }
      this.halfOpenInFlight = true;
    }

    try {
      const result = await this.fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    } finally {
      this.halfOpenInFlight = false;
    }
  }

  getState(): CircuitState {
    if (this.state === "open" && this.cooldownElapsed()) {
      return "half-open";
    }
    return this.state;
  }

  private cooldownElapsed(): boolean {
    return this.lastFailureTime !== null && Date.now() - this.lastFailureTime >= this.cooldownMs;
  }

  private onSuccess(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.lastFailureTime = null;
  }

  private onFailure(): void {
    this.failureCount += 1;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open" || this.failureCount >= this.failureThreshold) {
      this.state = "open";
    }
  }
}
