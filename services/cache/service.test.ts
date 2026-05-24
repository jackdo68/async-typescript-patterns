import { TTLCache } from "./service";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TTLCache", () => {
  // TEST 1: Happy path — value is cached and reused on subsequent gets
  it("returns the cached value on subsequent calls", async () => {
    const fetchFn = jest.fn(async (key: string) => `result-${key}`);
    const cache = new TTLCache(fetchFn, { ttlMs: 1000 });

    const first = await cache.get("a");
    const second = await cache.get("a");

    expect(first).toBe("result-a");
    expect(second).toBe("result-a");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // TEST 2: Expiry — after the TTL elapses, the next get re-fetches
  it("re-fetches after the TTL expires", async () => {
    const fetchFn = jest.fn(async () => "data");
    const cache = new TTLCache(fetchFn, { ttlMs: 30 });

    await cache.get("a");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await delay(50);

    await cache.get("a");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  // TEST 3: Thundering herd — N concurrent requests for the same key share ONE fetch
  it("deduplicates concurrent requests for the same key", async () => {
    const fetchFn = jest.fn(async () => {
      await delay(30);
      return "data";
    });
    const cache = new TTLCache(fetchFn, { ttlMs: 1000 });

    const results = await Promise.all([
      cache.get("a"),
      cache.get("a"),
      cache.get("a"),
      cache.get("a"),
      cache.get("a")
    ]);

    expect(results).toEqual(["data", "data", "data", "data", "data"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // TEST 4: Failure path — fetch error propagates to all waiters and nothing is cached
  it("propagates a fetch failure to all waiters and does not cache it", async () => {
    let attempt = 0;
    const fetchFn = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        await delay(10);
        throw new Error("upstream down");
      }
      return "recovered";
    });
    const cache = new TTLCache(fetchFn, { ttlMs: 1000 });

    const p1 = cache.get("a");
    const p2 = cache.get("a");

    await expect(p1).rejects.toThrow("upstream down");
    await expect(p2).rejects.toThrow("upstream down");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Next get retries (nothing cached from the failure)
    const recovered = await cache.get("a");
    expect(recovered).toBe("recovered");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  // BONUS: invalidate forces the next get to re-fetch
  it("re-fetches after invalidate", async () => {
    const fetchFn = jest.fn(async (key: string) => `result-${key}`);
    const cache = new TTLCache(fetchFn, { ttlMs: 10_000 });

    await cache.get("a");
    cache.invalidate("a");
    await cache.get("a");

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
