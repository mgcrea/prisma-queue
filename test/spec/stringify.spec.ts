import { describe, expect, it } from "vitest";

import { prepareForJson, restoreFromJson } from "src/utils";

describe("JSON serialization", () => {
  it("should handle undefined", () => {
    const original = undefined;
    const prepared = prepareForJson(original);
    const restored = restoreFromJson(prepared);
    expect(restored).toBe(original);
  });

  it("should handle bigint", () => {
    const original = BigInt(123456789);
    const prepared = prepareForJson(original);
    const restored = restoreFromJson<typeof original>(prepared);
    expect(restored).toBe(original);
  });

  it("should handle Map", () => {
    const original = new Map([["key", "value"]]);
    const prepared = prepareForJson(original);
    const restored = restoreFromJson<typeof original>(prepared);
    expect(restored).toEqual(original);
  });

  it("should handle Set", () => {
    const original = new Set(["item1", "item2"]);
    const prepared = prepareForJson(original);
    const restored = restoreFromJson<typeof original>(prepared);
    expect(restored).toEqual(original);
  });

  it("should handle Date", () => {
    const original = new Date();
    const prepared = prepareForJson(original);
    const restored = restoreFromJson<typeof original>(prepared);
    expect(restored.getTime()).toBe(original.getTime());
  });

  it("should handle object", () => {
    const original = { a: 1, b: 2, c: 3 };
    const prepared = prepareForJson(original);
    const restored = restoreFromJson<typeof original>(prepared);
    expect(restored).toEqual(original);
  });

  it("should handle array", () => {
    const original = [1, 2, 3];
    const prepared = prepareForJson(original);
    const restored = restoreFromJson<typeof original>(prepared);
    expect(restored).toEqual(original);
  });
});
