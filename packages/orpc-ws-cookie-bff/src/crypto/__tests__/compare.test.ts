import { describe, expect, it } from "vitest";

import { constantTimeEquals } from "../compare.js";

describe("constantTimeEquals", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEquals("abc123", "abc123")).toBe(true);
  });
  it("returns false for differing strings of equal length", () => {
    expect(constantTimeEquals("abc123", "abc124")).toBe(false);
  });
  it("returns false (no throw) for different lengths", () => {
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
  });
});
