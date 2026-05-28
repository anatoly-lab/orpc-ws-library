// D3 anti-corruption layer — contract tests.
//
// The normalizer is the single source of truth for "what shape did the
// upstream WebSocket / partysocket actually hand us?". These tests pin:
//   - the happy path (native CloseEvent with numeric code)
//   - the partysocket@1.1.19 cloneEventBrowser bug shape (`code: "close"`
//     string, original event under `reason`) — numeric code recovered
//   - parity between the property-handler path and addEventListener path
//   - field preservation (reason, wasClean)
//   - graceful fallback for malformed input
//   - open / error event normalization
//
// See `event-normalizer.ts` for the full bug explanation.

import { describe, expect, it, vi } from "vitest";

import {
  normalizeCloseEvent,
  normalizeErrorEvent,
  normalizeOpenEvent,
} from "../event-normalizer.js";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("normalizeCloseEvent — happy path", () => {
  it("native CloseEvent with numeric code: 1008 normalizes verbatim", () => {
    const ev = new CloseEvent("close", {
      code: 1008,
      reason: "policy",
      wasClean: true,
    });
    const out = normalizeCloseEvent(ev);
    expect(out).toEqual({
      type: "close",
      code: 1008,
      reason: "policy",
      wasClean: true,
    });
  });

  it("plain-object close shape (e.g. from a test stub) normalizes verbatim", () => {
    const out = normalizeCloseEvent({
      code: 4005,
      reason: "Session replaced",
      wasClean: true,
    });
    expect(out).toEqual({
      type: "close",
      code: 4005,
      reason: "Session replaced",
      wasClean: true,
    });
  });

  it("preserves wasClean === false for abnormal closes", () => {
    const out = normalizeCloseEvent({
      code: 1006,
      reason: "",
      wasClean: false,
    });
    expect(out.wasClean).toBe(false);
  });

  it("missing reason becomes empty string (never undefined)", () => {
    const out = normalizeCloseEvent({ code: 1000 });
    expect(out.reason).toBe("");
  });
});

describe("normalizeCloseEvent — partysocket@1.1.19 cloneEventBrowser bug shape", () => {
  // Reproduce the bug shape:
  //   partysocket's polyfilled CloseEvent has constructor signature
  //     (code = 1000, reason = "", target)
  //   cloneEventBrowser does
  //     new e.constructor(e.type, e)
  //   which calls
  //     new PolyfillCloseEvent("close", originalEvent)
  //   → this.code   = "close"             (string!)
  //   → this.reason = <original event>     (object!)
  //   → this.wasClean = true               (default)
  //
  // The normalizer must recover the numeric code from the original event.

  it("recovers numeric code from `reason` when `code` is the string \"close\"", () => {
    const original = { code: 1008, reason: "policy", wasClean: true };
    const buggy = {
      code: "close",   // string, NOT a number — the bug
      reason: original, // original event nested under reason — the bug
      wasClean: true,
    };
    const logger = makeLogger();
    const out = normalizeCloseEvent(buggy, { logger });
    expect(out).toEqual({
      type: "close",
      code: 1008,
      reason: "policy",
      wasClean: true,
    });
    // We log at debug level on successful recovery so consumers can detect
    // the bug shape in production without spamming higher levels.
    expect(logger.debug).toHaveBeenCalled();
  });

  it("recovers numeric code from `reason` for the 4005 session-replaced shape", () => {
    const original = {
      code: 4005,
      reason: "Session replaced",
      wasClean: true,
    };
    const buggy = { code: "close", reason: original, wasClean: true };
    expect(normalizeCloseEvent(buggy)).toEqual({
      type: "close",
      code: 4005,
      reason: "Session replaced",
      wasClean: true,
    });
  });

  it("addEventListener-clone shape and property-handler shape normalize to identical output", () => {
    // Property-handler shape: the ORIGINAL event with a real numeric code.
    const propertyShape = { code: 1008, reason: "policy", wasClean: true };
    // addEventListener-clone shape: the bug, with the original event nested.
    const listenerShape = {
      code: "close",
      reason: { code: 1008, reason: "policy", wasClean: true },
      wasClean: true,
    };
    expect(normalizeCloseEvent(propertyShape)).toEqual(
      normalizeCloseEvent(listenerShape),
    );
  });
});

describe("normalizeCloseEvent — malformed / pathological inputs", () => {
  it("null input → synthetic 1006 fallback + warn log", () => {
    const logger = makeLogger();
    const out = normalizeCloseEvent(null, { logger });
    expect(out).toEqual({
      type: "close",
      code: 1006,
      reason: "",
      wasClean: false,
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("undefined input → synthetic 1006 fallback", () => {
    const logger = makeLogger();
    const out = normalizeCloseEvent(undefined, { logger });
    expect(out.code).toBe(1006);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("non-event primitive input (number) → synthetic 1006 fallback", () => {
    expect(normalizeCloseEvent(42).code).toBe(1006);
  });

  it("event with NaN code is treated as non-numeric and falls back", () => {
    const logger = makeLogger();
    // NaN is a number but is not a real close code; we reject and log.
    const out = normalizeCloseEvent(
      { code: Number.NaN, reason: "huh" },
      { logger },
    );
    expect(out.code).toBe(1006);
    expect(out.reason).toBe("huh");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("non-numeric code with no recoverable inner event → 1006 fallback + warn log", () => {
    const logger = makeLogger();
    const out = normalizeCloseEvent(
      { code: "close", reason: "string-reason" },
      { logger },
    );
    expect(out.code).toBe(1006);
    expect(out.reason).toBe("string-reason");
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("normalizeOpenEvent / normalizeErrorEvent", () => {
  it("normalizeOpenEvent ignores payload and returns the canonical shape", () => {
    expect(normalizeOpenEvent(undefined)).toEqual({ type: "open" });
    expect(normalizeOpenEvent({ anything: "here" })).toEqual({ type: "open" });
  });

  it("normalizeErrorEvent preserves the message", () => {
    expect(normalizeErrorEvent({ message: "boom" })).toEqual({
      type: "error",
      message: "boom",
    });
  });

  it("normalizeErrorEvent unwraps a nested `error.message`", () => {
    expect(
      normalizeErrorEvent({ error: { message: "nested" } }),
    ).toEqual({ type: "error", message: "nested" });
  });

  it("normalizeErrorEvent on malformed input falls back to empty message", () => {
    expect(normalizeErrorEvent(null)).toEqual({ type: "error", message: "" });
    expect(normalizeErrorEvent({})).toEqual({ type: "error", message: "" });
  });
});
