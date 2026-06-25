import { describe, expect, it } from "vitest";

import { csrfTokenValid, mintCsrfToken } from "../csrf.js";

describe("mintCsrfToken", () => {
  it("is a base64url string and unique per call", () => {
    const a = mintCsrfToken();
    const b = mintCsrfToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});

// Synchronizer-token validation: the echoed header vs the session-stored token
// (constant-time). No cookie is involved anymore.
describe("csrfTokenValid", () => {
  const token = mintCsrfToken();

  it("accepts a matching echo vs session token", () => {
    expect(csrfTokenValid(token, token)).toBe(true);
  });

  it("rejects a mismatched echo", () => {
    expect(csrfTokenValid(mintCsrfToken(), token)).toBe(false);
  });

  it("rejects when the echoed header is missing", () => {
    expect(csrfTokenValid(undefined, token)).toBe(false);
  });

  it("rejects when the session has no stored token", () => {
    expect(csrfTokenValid(token, undefined)).toBe(false);
  });
});
