// Unit tests for the two authless key seams.
//
// - `createSingleAuthlessKey` (DEFAULT): a CONSTANT key so every authless
//   socket collides on one registry entry and a new connection kicks the
//   previous (single global connection).
// - `createAuthlessKeyFactory` (opt-out): UNIQUE per-call DETERMINISTIC keys
//   (monotonic counter, not Math.random/Date.now) so concurrent authless
//   sockets coexist and the foot-gun regression can rely on stable keys.

import { describe, expect, it } from "vitest";

import {
  createAuthlessKeyFactory,
  createSingleAuthlessKey,
  SINGLE_AUTHLESS_KEY,
} from "../authless-key.js";

describe("createSingleAuthlessKey", () => {
  it("always yields the same constant key (so all authless sockets collide)", () => {
    const next = createSingleAuthlessKey();
    expect([next(), next(), next()]).toEqual([
      SINGLE_AUTHLESS_KEY,
      SINGLE_AUTHLESS_KEY,
      SINGLE_AUTHLESS_KEY,
    ]);
    expect(SINGLE_AUTHLESS_KEY).toBe("authless");
  });
});

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
