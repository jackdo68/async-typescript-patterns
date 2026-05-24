import { processWithConcurrency } from "./service";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("processWithConcurrency", () => {
  // TEST 1: Happy path — all items processed, results in original order
  it("processes all items and preserves order", async () => {
    const fn = async (x: number) => x * 2;
    const results = await processWithConcurrency([1, 2, 3], fn, 2);

    expect(results).toEqual([
      { status: "fulfilled", value: 2 },
      { status: "fulfilled", value: 4 },
      { status: "fulfilled", value: 6 }
    ]);
  });

  // TEST 2: Concurrency limit — never more than N in-flight at once
  it("respects the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;

    const fn = async (x: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(20);
      active--;
      return x;
    };

    await processWithConcurrency([1, 2, 3, 4, 5], fn, 2);

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  // TEST 3: Per-item failure — one rejection doesn't kill the batch
  it("captures individual failures without killing the batch", async () => {
    const fn = async (x: number) => {
      if (x === 2) throw new Error("item 2 failed");
      return x * 2;
    };

    const results = await processWithConcurrency([1, 2, 3], fn, 3);

    expect(results[0]).toEqual({ status: "fulfilled", value: 2 });
    expect(results[1]?.status).toBe("rejected");
    expect(results[1]?.error?.message).toBe("item 2 failed");
    expect(results[2]).toEqual({ status: "fulfilled", value: 6 });
  });

  // TEST 4: Empty input — returns an empty array, fn never called
  it("handles empty input", async () => {
    const fn = jest.fn(async (x: number) => x);
    const results = await processWithConcurrency([], fn, 5);

    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  // BONUS: concurrency > items — workers cap at items.length
  it("does not spawn more workers than items", async () => {
    let active = 0;
    let maxActive = 0;

    const fn = async (x: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active--;
      return x;
    };

    await processWithConcurrency([1, 2], fn, 100);

    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
