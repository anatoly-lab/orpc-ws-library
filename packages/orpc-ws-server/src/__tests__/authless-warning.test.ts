// REGRESSION: an authless server must NOT emit a spurious config warning on
// a clean boot — and MUST still warn when a user-identity knob is set explicitly.
//
// The bug (fixed): the constructor inferred "stray config" from the MERGED
// connection config. Because `DEFAULT_CONNECTION_CONFIG.singleConnectionPerUser`
// is `true`, every authless server tripped the guard and logged a confusing
// "singleConnectionPerUser ignored" warning on EVERY boot — even though the
// consumer never set it (the typed authless factory omits the knob entirely).
//
// The fix, asserted here: warn ONLY when the knob was passed via
// `opts.connection`; otherwise force it off SILENTLY. This slipped through
// originally because every other authless test uses the noop logger — so this
// one asserts against a SPY logger.

import { describe, expect, it, vi } from "vitest";

import { OrpcWsServer, createAuthlessOrpcWsServer } from "../index.js";
import type { NoAuth } from "../state/no-auth.js";

function spyLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// Empty consumer router — the library still merges its heartbeat sub-router.
const router = {};

describe("AUTHLESS — config-warning behavior", () => {
  it("clean boot via createAuthlessOrpcWsServer emits ZERO warn calls", () => {
    const logger = spyLogger();
    createAuthlessOrpcWsServer({ router, logger });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns when singleConnectionPerUser is explicitly set (raw-class path)", () => {
    const logger = spyLogger();
    // The raw class / NestJS DI path can still pass the knob the typed
    // authless factory omits. No verifyClient → the class constructs authless.
    new OrpcWsServer<NoAuth, typeof router>({
      router,
      connection: { singleConnectionPerUser: true },
      logger,
    });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("singleConnectionPerUser"),
    );
  });

  it("warns when enforceTokenExpiry is explicitly set (raw-class path)", () => {
    const logger = spyLogger();
    new OrpcWsServer<NoAuth, typeof router>({
      router,
      connection: { enforceTokenExpiry: true },
      logger,
    });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("enforceTokenExpiry"),
    );
  });
});
