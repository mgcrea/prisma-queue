import { calculateDelay, intervalToMs, MAX_TIMEOUT_DELAY } from "src/utils";
import { describe, expect, it } from "vitest";

describe("calculateDelay", () => {
  it("should grow exponentially with attempts", () => {
    // jitter adds up to 100ms, so compare the floors
    expect(calculateDelay(1)).toBeGreaterThanOrEqual(2000);
    expect(calculateDelay(2)).toBeGreaterThanOrEqual(4000);
    expect(calculateDelay(3)).toBeGreaterThanOrEqual(8000);
  });
  it("should clamp to the provided maxDelay", () => {
    // 1000 * 2^30 is far above any sane ceiling, so the cap dominates.
    expect(calculateDelay(30, 5000)).toBe(5000);
    expect(calculateDelay(50, 60_000)).toBe(60_000);
  });
  it("should never exceed the setTimeout ceiling even without an explicit cap", () => {
    expect(calculateDelay(50)).toBeLessThanOrEqual(MAX_TIMEOUT_DELAY);
  });
});

describe("intervalToMs", () => {
  it("should sum components", () => {
    expect(intervalToMs({ seconds: 1 })).toBe(1000);
    expect(intervalToMs({ minutes: 1 })).toBe(60_000);
    expect(intervalToMs({ hours: 1 })).toBe(3_600_000);
    expect(intervalToMs({ days: 1 })).toBe(86_400_000);
    expect(intervalToMs({ minutes: 1, seconds: 30 })).toBe(90_000);
  });
  it("should reject non-positive durations", () => {
    expect(() => intervalToMs({})).toThrow();
    expect(() => intervalToMs({ seconds: 0 })).toThrow();
  });
});
