import { CircuitBreaker, CircuitOpenError } from "./service";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("CircuitBreaker", () => {
  // TEST 1: Happy path — closed circuit passes calls through
  it("passes calls through and stays closed on success", async () => {
    const fn = jest.fn(async () => "ok");
    const breaker = new CircuitBreaker(fn, { failureThreshold: 3, cooldownMs: 1000 });

    const result = await breaker.execute();

    expect(result).toBe("ok");
    expect(breaker.getState()).toBe("closed");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // TEST 2: Opens after the failure threshold and short-circuits subsequent calls
  it("opens after the failure threshold and rejects without invoking fn", async () => {
    const fn = jest.fn(async () => {
      throw new Error("upstream down");
    });
    const breaker = new CircuitBreaker(fn, { failureThreshold: 3, cooldownMs: 1000 });

    for (let i = 0; i < 3; i++) {
      await breaker.execute().catch(() => {});
    }

    expect(breaker.getState()).toBe("open");
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(breaker.execute()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).toHaveBeenCalledTimes(3); // fn was NOT invoked while open
  });

  // TEST 3: After cooldown, transitions to half-open and recovers on success
  it("transitions to half-open after cooldown and closes on a successful test", async () => {
    let shouldFail = true;
    const fn = jest.fn(async () => {
      if (shouldFail) throw new Error("fail");
      return "recovered";
    });
    const breaker = new CircuitBreaker(fn, { failureThreshold: 2, cooldownMs: 30 });

    await breaker.execute().catch(() => {});
    await breaker.execute().catch(() => {});
    expect(breaker.getState()).toBe("open");

    await delay(50);
    shouldFail = false;

    const result = await breaker.execute();

    expect(result).toBe("recovered");
    expect(breaker.getState()).toBe("closed");
  });

  // TEST 4: Half-open test that fails re-opens the circuit
  it("re-opens the circuit when the half-open test request fails", async () => {
    const fn = jest.fn(async () => {
      throw new Error("still broken");
    });
    const breaker = new CircuitBreaker(fn, { failureThreshold: 2, cooldownMs: 30 });

    await breaker.execute().catch(() => {});
    await breaker.execute().catch(() => {});
    expect(breaker.getState()).toBe("open");

    await delay(50);
    expect(breaker.getState()).toBe("half-open"); // observation only

    await expect(breaker.execute()).rejects.toThrow("still broken");
    expect(breaker.getState()).toBe("open");
  });

  // TEST 5: Only one test request is allowed during half-open
  it("only allows a single in-flight test request during half-open", async () => {
    let resolveFirst!: () => void;
    const fn = jest.fn(async () => {
      await new Promise<void>((r) => {
        resolveFirst = r;
      });
      return "ok";
    });
    const breaker = new CircuitBreaker(fn, { failureThreshold: 1, cooldownMs: 30 });

    // Trip the breaker
    fn.mockImplementationOnce(async () => {
      throw new Error("trip");
    });
    await breaker.execute().catch(() => {});
    expect(breaker.getState()).toBe("open");

    await delay(50);

    // First call in half-open — hangs until we let it through
    const first = breaker.execute();

    // Give the microtask a chance to flip state to "half-open" and set halfOpenInFlight = true
    await delay(5);

    // Second concurrent call must be short-circuited
    await expect(breaker.execute()).rejects.toBeInstanceOf(CircuitOpenError);

    resolveFirst();
    await expect(first).resolves.toBe("ok");
    expect(breaker.getState()).toBe("closed");
  });

  // BONUS: a single success below the threshold resets the failure count
  it("resets the failure count on a successful call", async () => {
    let nextFails = true;
    const fn = jest.fn(async () => {
      if (nextFails) throw new Error("fail");
      return "ok";
    });
    const breaker = new CircuitBreaker(fn, { failureThreshold: 3, cooldownMs: 1000 });

    await breaker.execute().catch(() => {}); // failure 1
    await breaker.execute().catch(() => {}); // failure 2

    nextFails = false;
    await breaker.execute(); // success — count resets

    nextFails = true;
    await breaker.execute().catch(() => {}); // failure 1 (fresh count)
    await breaker.execute().catch(() => {}); // failure 2

    // Still closed — without reset we'd be at 4 failures and open
    expect(breaker.getState()).toBe("closed");
  });
});
