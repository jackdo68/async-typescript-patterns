import { KeyedMutex, Mutex } from "./service";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Mutex", () => {
  // TEST 1: The canonical race — without the lock the balance goes negative.
  // With the lock, withdrawals are serialised and the invariant holds.
  it("serialises concurrent operations on shared state", async () => {
    const lock = new Mutex();
    let balance = 100;

    const withdraw = (amount: number) =>
      lock.withLock(async () => {
        if (balance >= amount) {
          await delay(5); // simulates a slow check; would interleave without the lock
          balance -= amount;
          return true;
        }
        return false;
      });

    const results = await Promise.all([withdraw(75), withdraw(75)]);

    expect(results.filter((r) => r === true)).toHaveLength(1);
    expect(results.filter((r) => r === false)).toHaveLength(1);
    expect(balance).toBe(25);
  });

  // TEST 2: Lock is released when fn throws — next acquirer must not deadlock
  it("releases the lock when fn throws", async () => {
    const lock = new Mutex();

    await expect(
      lock.withLock(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // If the lock were leaked this would hang forever
    const result = await lock.withLock(async () => "recovered");

    expect(result).toBe("recovered");
    expect(lock.isLocked()).toBe(false);
  });

  // TEST 3: FIFO — queued acquirers are served in submission order
  it("serves waiters in FIFO order", async () => {
    const lock = new Mutex();
    const order: number[] = [];

    await Promise.all([
      lock.withLock(async () => {
        await delay(20);
        order.push(1);
      }),
      lock.withLock(async () => {
        order.push(2);
      }),
      lock.withLock(async () => {
        order.push(3);
      })
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  // TEST 4: Manual acquire/release works and isLocked reflects state
  it("supports manual acquire/release with accurate isLocked", async () => {
    const lock = new Mutex();
    expect(lock.isLocked()).toBe(false);

    const release = await lock.acquire();
    expect(lock.isLocked()).toBe(true);

    release();
    expect(lock.isLocked()).toBe(false);
  });

  // TEST 5: Double release is a no-op — defensive against finally-block double-calls
  it("treats a double release as a no-op", async () => {
    const lock = new Mutex();
    const release = await lock.acquire();

    release();
    release(); // should not corrupt waiterCount

    expect(lock.isLocked()).toBe(false);

    // Lock is still usable
    const release2 = await lock.acquire();
    expect(lock.isLocked()).toBe(true);
    release2();
  });
});

describe("KeyedMutex", () => {
  // TEST 1: Same key serialises — race fix is per-key, not global
  it("serialises operations on the same key", async () => {
    const lock = new KeyedMutex<string>();
    const balances = new Map<string, number>([["acct-1", 100]]);

    const withdraw = (acct: string, amount: number) =>
      lock.withLock(acct, async () => {
        const current = balances.get(acct)!;
        if (current >= amount) {
          await delay(5);
          balances.set(acct, current - amount);
        }
      });

    await Promise.all([withdraw("acct-1", 75), withdraw("acct-1", 75)]);

    expect(balances.get("acct-1")).toBe(25);
  });

  // TEST 2: Different keys do NOT block each other — that's the whole point
  it("does not block operations on different keys", async () => {
    const lock = new KeyedMutex<string>();
    const order: string[] = [];

    await Promise.all([
      lock.withLock("a", async () => {
        order.push("a-start");
        await delay(40);
        order.push("a-end");
      }),
      lock.withLock("b", async () => {
        order.push("b-start");
        await delay(10);
        order.push("b-end");
      })
    ]);

    // If serialised, b-end would land after a-end. Concurrent → b-end first.
    expect(order.indexOf("b-end")).toBeLessThan(order.indexOf("a-end"));
  });

  // TEST 3: Cleanup — per-key Mutex is dropped once idle, keeping memory bounded
  it("drops the per-key Mutex once it is idle", async () => {
    const lock = new KeyedMutex<string>();

    await lock.withLock("a", async () => {});

    expect(lock.isLocked("a")).toBe(false);
    // Internal: the map should not retain the entry. Re-using "a" creates a fresh lock,
    // which is fine — the contract is per-key serialisation, not lock identity.
    expect((lock as unknown as { locks: Map<string, unknown> }).locks.has("a")).toBe(false);
  });

  // TEST 4: Failure on one key doesn't poison other keys
  it("isolates failures to the failing key", async () => {
    const lock = new KeyedMutex<string>();

    await expect(
      lock.withLock("a", async () => {
        throw new Error("a failed");
      })
    ).rejects.toThrow("a failed");

    // Key "b" — never touched — is obviously fine
    const b = await lock.withLock("b", async () => "b-ok");
    expect(b).toBe("b-ok");

    // Key "a" — must also still work; failure didn't leak a held lock
    const a = await lock.withLock("a", async () => "a-recovered");
    expect(a).toBe("a-recovered");
  });
});
