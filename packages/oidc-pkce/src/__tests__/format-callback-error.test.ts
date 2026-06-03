// format-callback-error.test.ts — the default CallbackError rendering.
//
// One test per union variant. We assert the salient data is carried through
// (HTTP status + raw body for exchange_failed; error + description for
// idp_error) and that the param-less variants return non-empty, stable copy.
// The exhaustiveness guard itself is a compile-time concern (a missing variant
// won't compile) so there's nothing to assert at runtime for it.

import { describe, it, expect } from "vitest";

import { formatCallbackError } from "../format-callback-error.js";

describe("formatCallbackError", () => {
  it("renders non-empty stable copy for state_mismatch", () => {
    const msg = formatCallbackError({ type: "state_mismatch" });
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toMatch(/sign-in/i);
  });

  it("renders non-empty stable copy for missing_code", () => {
    const msg = formatCallbackError({ type: "missing_code" });
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toMatch(/authorization code/i);
  });

  it("includes the HTTP status and raw body for exchange_failed", () => {
    const msg = formatCallbackError({
      type: "exchange_failed",
      status: 400,
      body: "invalid_grant",
    });
    expect(msg).toContain("400");
    expect(msg).toContain("invalid_grant");
    // The body is on its own line: the default renders inside a <pre>, so the
    // newline separator is whitespace-significant and must not silently drop.
    expect(msg).toContain("\n");
  });

  it("includes the error code for idp_error", () => {
    const msg = formatCallbackError({
      type: "idp_error",
      error: "access_denied",
    });
    expect(msg).toContain("access_denied");
  });

  it("includes the description for idp_error when present", () => {
    const msg = formatCallbackError({
      type: "idp_error",
      error: "access_denied",
      description: "The user declined the consent prompt.",
    });
    expect(msg).toContain("access_denied");
    expect(msg).toContain("The user declined the consent prompt.");
    // Description on its own line (same <pre> whitespace concern as above).
    expect(msg).toContain("\n");
  });
});
