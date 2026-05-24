import { DomainScanner } from "./service";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("DomainScanner", () => {
  // TEST 1: Happy path — all checks pass, report aggregates their data
  it("runs all checks concurrently and aggregates their results", async () => {
    const scanner = new DomainScanner({
      tls: async () => ({ version: "TLSv1.3" }),
      dns: async () => ({ hasDNSSEC: true })
    });

    const report = await scanner.scan("example.com");

    expect(report.target).toBe("example.com");
    expect(report.scannedAt).toBeInstanceOf(Date);
    expect(report.results.tls).toEqual({ status: "passed", data: { version: "TLSv1.3" } });
    expect(report.results.dns).toEqual({ status: "passed", data: { hasDNSSEC: true } });
  });

  // TEST 2: Per-check failure — one error doesn't kill the rest of the report
  it("captures individual check failures without killing the scan", async () => {
    const scanner = new DomainScanner({
      tls: async () => ({ version: "TLSv1.3" }),
      dns: async () => {
        throw new Error("DNS lookup failed");
      }
    });

    const report = await scanner.scan("example.com");

    expect(report.results.tls.status).toBe("passed");
    expect(report.results.dns).toEqual({ status: "error", error: "DNS lookup failed" });
  });

  // TEST 3: Timeout — slow checks are bounded and reported as errors
  it("times out slow checks without blocking the rest", async () => {
    const scanner = new DomainScanner(
      {
        fast: async () => "done",
        slow: async () => {
          await delay(500);
          return "late";
        }
      },
      { timeoutMs: 30 }
    );

    const start = Date.now();
    const report = await scanner.scan("example.com");
    const elapsed = Date.now() - start;

    expect(report.results.fast).toEqual({ status: "passed", data: "done" });
    expect(report.results.slow.status).toBe("error");
    if (report.results.slow.status === "error") {
      expect(report.results.slow.error).toContain("timed out");
    }
    // Should resolve at ~timeoutMs, not at the slow check's 500ms
    expect(elapsed).toBeLessThan(200);
  });

  // TEST 4: Checks run concurrently, not sequentially
  it("runs checks concurrently (total time ~ slowest check, not the sum)", async () => {
    const scanner = new DomainScanner({
      a: async () => {
        await delay(40);
        return "a";
      },
      b: async () => {
        await delay(40);
        return "b";
      },
      c: async () => {
        await delay(40);
        return "c";
      }
    });

    const start = Date.now();
    await scanner.scan("example.com");
    const elapsed = Date.now() - start;

    // Sequential would be ~120ms; concurrent should be ~40ms (allow generous slack for CI)
    expect(elapsed).toBeLessThan(100);
  });

  // BONUS: empty checks → empty results, scan still resolves
  it("handles a scanner with no checks", async () => {
    const scanner = new DomainScanner({});
    const report = await scanner.scan("example.com");

    expect(report.target).toBe("example.com");
    expect(report.results).toEqual({});
  });
});
