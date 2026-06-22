// Unit test for the authless unique-key seam.
//
// The keys must be UNIQUE per call and DETERMINISTIC (monotonic counter,
// not Math.random/Date.now) so the foot-gun regression test can rely on
// stable keys.

import { describe, expect, it } from "vitest";

import { createAuthlessKeyFactory } from "../authless-key.js";

describe("createAuthlessKeyFactory", () => {
  it("yields unique, monotonic keys", () => {
    const next = createAuthlessKeyFactory();
    const keys = [next(), next(), next()];

    expect(keys).toEqual(["authless#1", "authless#2", "authless#3"]);
    expect(new Set(keys).size).toBe(3);
  });

  it("each factory has its own independent counter", () => {
    const a = createAuthlessKeyFactory();
    const b = createAuthlessKeyFactory();

    expect(a()).toBe("authless#1");
    expect(b()).toBe("authless#1"); // independent — does not share a's counter
    expect(a()).toBe("authless#2");
  });
});
