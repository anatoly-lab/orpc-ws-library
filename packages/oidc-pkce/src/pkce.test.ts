// PKCE primitive tests.
//
// The RFC 7636 Appendix B fixture (`dBjftJeZ...` → `E9Melhoa...`) is the
// canonical regression: it pins SHA-256, base64url encoding, and the
// TextEncoder boundary in a single assertion. If any of these regress
// we want a loud, named failure.

import { describe, it, expect } from "vitest";

import { generateState, generateVerifier, pkceChallenge } from "./pkce.js";

describe("pkce", () => {
  describe("generateVerifier", () => {
    it("produces a base64url string in the RFC 7636 length range (43..128)", () => {
      const v = generateVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      // Only the base64url alphabet.
      expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("produces different values on consecutive calls", () => {
      // Probabilistic but with 512 bits of entropy the collision odds
      // are ~0; a failure here means crypto.getRandomValues is broken
      // or the encoder is reusing buffers.
      const a = generateVerifier();
      const b = generateVerifier();
      expect(a).not.toBe(b);
    });
  });

  describe("generateState", () => {
    it("produces a base64url string of ~43 chars (32 bytes)", () => {
      const s = generateState();
      expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
      // 32 bytes -> ceil(32*4/3) = 43 chars after padding strip.
      expect(s.length).toBe(43);
    });

    it("produces different values on consecutive calls", () => {
      expect(generateState()).not.toBe(generateState());
    });
  });

  describe("pkceChallenge", () => {
    it("matches the RFC 7636 Appendix B fixture", async () => {
      // From RFC 7636 Appendix B: this exact verifier -> exact challenge.
      // Pins the entire SHA-256 + base64url + UTF-8 path.
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
      expect(await pkceChallenge(verifier)).toBe(expected);
    });

    it("is deterministic for a given verifier", async () => {
      const v = generateVerifier();
      const c1 = await pkceChallenge(v);
      const c2 = await pkceChallenge(v);
      expect(c1).toBe(c2);
    });
  });
});
