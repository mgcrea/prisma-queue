import * as exported from "src/index";
import { describe, expect, it } from "vitest";

describe("module", () => {
  it("should export a stable API", () => {
    expect(exported).toMatchSnapshot();
  });
});
