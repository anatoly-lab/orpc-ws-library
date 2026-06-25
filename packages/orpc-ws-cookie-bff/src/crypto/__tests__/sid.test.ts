import { describe, expect, it } from "vitest";

import { mintSid } from "../sid.js";

describe("mintSid", () => {
  it("is 64 lowercase hex chars (256 bits)", () => {
    const sid = mintSid();
    expect(sid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is unique across calls (no collisions over a large sample)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(mintSid());
    expect(seen.size).toBe(10_000);
  });
});
