// S1 regression — finite `reconnect.maxRetries` is unsupported.
//
// docs/fable/resolution-status.md S1 (resolved "document as unsupported"):
// the library assumes UNBOUNDED partysocket retries and owns "give up" at the
// right layer (storm guard → terminal, 4005 kick, dispose). partysocket emits
// nothing when its retry loop exhausts, so a finite `maxRetries` would wedge
// `connect()` as a permanent no-op with no signal — and the library can't
// detect that without reading partysocket internals. `resolveReconnectConfig`
// therefore warns and forces a finite override back to Infinity, keeping the
// "library owns give-up" contract real without depending on partysocket
// internals.

import { describe, expect, it, vi } from "vitest";

import type { Logger } from "@repo/orpc-ws-shared";

import {
  DEFAULT_RECONNECT_CONFIG,
  resolveReconnectConfig,
} from "../reconnect-config.js";

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("resolveReconnectConfig — finite maxRetries is unsupported (S1)", () => {
  it("forces a finite maxRetries back to Infinity and warns", () => {
    const logger = makeLogger();
    const cfg = resolveReconnectConfig({ maxRetries: 5 }, logger);

    expect(cfg.maxRetries).toBe(Number.POSITIVE_INFINITY);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The warning carries the rejected value for diagnostics.
    expect(logger.warn.mock.calls[0]?.[1]).toEqual({ requested: 5 });
  });

  it("leaves the default Infinity untouched and does NOT warn", () => {
    const logger = makeLogger();
    const cfg = resolveReconnectConfig(undefined, logger);

    expect(cfg.maxRetries).toBe(Number.POSITIVE_INFINITY);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not warn when maxRetries is explicitly Infinity", () => {
    const logger = makeLogger();
    const cfg = resolveReconnectConfig(
      { maxRetries: Number.POSITIVE_INFINITY },
      logger,
    );

    expect(cfg.maxRetries).toBe(Number.POSITIVE_INFINITY);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("merges every OTHER override field normally (only maxRetries is constrained)", () => {
    const logger = makeLogger();
    const cfg = resolveReconnectConfig(
      { debounceMs: 250, jitterMs: 0, minReconnectionDelay: 2000 },
      logger,
    );

    expect(cfg.debounceMs).toBe(250);
    expect(cfg.jitterMs).toBe(0);
    expect(cfg.minReconnectionDelay).toBe(2000);
    // Untouched fields fall back to the defaults.
    expect(cfg.maxReconnectionDelay).toBe(
      DEFAULT_RECONNECT_CONFIG.maxReconnectionDelay,
    );
    expect(cfg.minRefreshIntervalMs).toBe(
      DEFAULT_RECONNECT_CONFIG.minRefreshIntervalMs,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
