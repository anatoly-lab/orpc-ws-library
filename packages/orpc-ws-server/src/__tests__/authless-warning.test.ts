// REGRESSION: an authless server must NOT emit a spurious config warning on
// a clean boot — and MUST still warn when the (still-meaningless in authless)
// `enforceTokenExpiry` knob is set explicitly.
//
// The original bug: the constructor inferred "stray config" from the MERGED
// connection config, so every authless server tripped the guard and logged a
// confusing warning on EVERY boot even though the consumer set nothing.
//
// NOTE (behavior change): `singleConnectionPerUser` is NO LONGER warned about
// in authless mode. It used to be forced off (and "ignored"); now it is
// MEANINGFUL — authless defaults to a single global connection (a new
// connection kicks the previous), controlled by the factory's
// `allowConcurrentConnections`. Only `enforceTokenExpiry` remains a
// no-op-in-authless knob that warns when explicitly set. This one asserts
// against a SPY logger (every other authless test uses the noop logger).

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

  it("does NOT warn when singleConnectionPerUser is set (it is now meaningful in authless)", () => {
    const logger = spyLogger();
    // Behavior change: authless honors single-connection enforcement now (it
    // is the default, giving the new-kicks-previous model), so passing the
    // knob is no longer "ignored" and must NOT log a warning. No verifyClient
    // → the class constructs authless.
    new OrpcWsServer<NoAuth, typeof router>({
      router,
      connection: { singleConnectionPerUser: true },
      logger,
    });
    expect(logger.warn).not.toHaveBeenCalled();
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
