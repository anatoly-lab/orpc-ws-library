// Event normalizer — D3 anti-corruption layer.
//
// Phase 1.2 NEW file. Splits "what shape did partysocket / native WebSocket
// just hand us?" away from "what should we do about it?". The orchestration
// (event-handlers.ts) and the pure decision (close-decision.ts) only ever
// look at NormalizedXxxEvent shapes; this module owns every quirk of every
// upstream event source.
//
// === Why this exists: the partysocket@1.1.19 cloneEventBrowser bug ===
//
// partysocket@1.1.19 dispatches its own internal CloseEvent via two paths:
//   (1) property-assigned `ws.onclose = ...`  — receives the ORIGINAL event
//                                               (real numeric `code`).
//   (2) `ws.addEventListener("close", ...)`   — receives a CLONED event via
//                                               cloneEventBrowser, which is
//                                                  new e.constructor(e.type, e)
//                                               When `e.constructor` is
//                                               partysocket's POLYFILLED
//                                               CloseEvent class (which has
//                                               the constructor signature
//                                                  (code, reason, target)
//                                               rather than the spec
//                                                  (type, eventInitDict)
//                                               ), the cloned event carries
//                                                  code:   "close"   (string)
//                                                  reason: <original event>
//                                                  wasClean: true
//                                               i.e. the string event TYPE
//                                               lands in the numeric `code`
//                                               slot, and the entire
//                                               original event is hiding
//                                               under `reason`.
//
// `lifecycle/websocket-factory.ts` deliberately uses path (1), so under
// nominal operation we receive a clean numeric `code`. But the normalizer
// runs on EVERY close to be defense-in-depth:
//   - Some test code paths attach via addEventListener and exercise path (2).
//   - The factory is a seam; a future maintainer might swap in addEventListener.
//   - The wider library may receive externally-produced events.
//
// Recovery strategy (option (a) in the design notes): when we detect the
// bug shape (`code` is the string "close" or otherwise non-numeric), we
// look at `reason`, which is the original event. If the original carries
// a numeric `.code`, we recover it. Otherwise we fall back to 1006
// (abnormal closure — RFC 6455 §7.4.1) and log so the consumer sees the
// degradation rather than silently misclassifying as 1000.
//
// References:
//   - source app's `lifecycle/websocket-factory.ts` comment on
//     "property assignment for standard WS events"
//   - design doc §"D3 — event-normalizer as anti-corruption layer"
//   - partysocket commit 78ae224 (cloneEventBrowser introduced)

import { type Logger, noopLogger } from "@orpc-ws/shared";

/** Normalized close-event shape used by the rest of the lifecycle module. */
export type NormalizedCloseEvent = {
  type: "close";
  code: number;
  reason: string;
  wasClean: boolean;
};

/** Normalized open-event shape — open carries no payload of interest. */
export type NormalizedOpenEvent = {
  type: "open";
};

/** Normalized error-event shape — only the message is preserved. */
export type NormalizedErrorEvent = {
  type: "error";
  message: string;
};

/**
 * WebSocket close code used as a fallback when the raw event is malformed
 * or carries a non-numeric code we could not recover. RFC 6455 §7.4.1:
 * 1006 = "Abnormal Closure", reserved for cases where the connection was
 * closed without a Close control frame being received.
 */
const FALLBACK_CLOSE_CODE = 1006;

interface NormalizerOptions {
  logger?: Logger;
}

/**
 * Normalize a close event from any source into NormalizedCloseEvent.
 *
 * Handles:
 *   - Native browser CloseEvent (preferred path; `code` is numeric)
 *   - partysocket@1.1.19 cloneEventBrowser bug shape (recovers from `reason`)
 *   - Malformed input (null/undefined/non-object) → synthetic 1006 + log
 *
 * Never throws; always returns a NormalizedCloseEvent. The orchestration
 * layer should never see a malformed close.
 */
export function normalizeCloseEvent(
  raw: unknown,
  options: NormalizerOptions = {},
): NormalizedCloseEvent {
  const logger = options.logger ?? noopLogger;

  if (!isObject(raw)) {
    logger.warn("event-normalizer: malformed close event, falling back", {
      raw: describeRaw(raw),
    });
    return {
      type: "close",
      code: FALLBACK_CLOSE_CODE,
      reason: "",
      wasClean: false,
    };
  }

  const rawCode = (raw as { code?: unknown }).code;
  const rawReason = (raw as { reason?: unknown }).reason;
  const rawWasClean = (raw as { wasClean?: unknown }).wasClean;

  // Happy path: numeric code, primitive reason. Native browser CloseEvent
  // and any well-formed event-init both hit this branch.
  if (typeof rawCode === "number" && Number.isFinite(rawCode)) {
    return {
      type: "close",
      code: rawCode,
      reason: typeof rawReason === "string" ? rawReason : "",
      wasClean: typeof rawWasClean === "boolean" ? rawWasClean : false,
    };
  }

  // Bug shape: partysocket@1.1.19 cloneEventBrowser fed an event whose
  // constructor is partysocket's polyfilled CloseEvent. The string event
  // type ends up in `code`, and the original event is in `reason`.
  if (isObject(rawReason)) {
    const innerCode = (rawReason as { code?: unknown }).code;
    if (typeof innerCode === "number" && Number.isFinite(innerCode)) {
      const innerReason = (rawReason as { reason?: unknown }).reason;
      const innerWasClean = (rawReason as { wasClean?: unknown }).wasClean;
      logger.debug(
        "event-normalizer: recovered numeric code from partysocket cloneEventBrowser bug shape",
        { recoveredCode: innerCode },
      );
      return {
        type: "close",
        code: innerCode,
        reason: typeof innerReason === "string" ? innerReason : "",
        wasClean:
          typeof innerWasClean === "boolean" ? innerWasClean : false,
      };
    }
  }

  // Last resort: log and synthesize 1006. Better to surface a network-drop
  // classification than to silently misroute (e.g. masking what was really
  // an auth failure as a "normal close").
  logger.warn(
    "event-normalizer: close event has no recoverable numeric code, using 1006 fallback",
    { code: describeRaw(rawCode) },
  );
  return {
    type: "close",
    code: FALLBACK_CLOSE_CODE,
    reason: typeof rawReason === "string" ? rawReason : "",
    wasClean: typeof rawWasClean === "boolean" ? rawWasClean : false,
  };
}

/**
 * Normalize an open event. Currently a thin shape; structural to keep the
 * orchestration layer's contract uniform across event types.
 */
export function normalizeOpenEvent(_raw: unknown): NormalizedOpenEvent {
  return { type: "open" };
}

/**
 * Normalize an error event. Only the message is extracted; raw errors are
 * deliberately not propagated since the rest of the library treats error
 * notifications as opaque (state stays put; logging only — matches source).
 */
export function normalizeErrorEvent(raw: unknown): NormalizedErrorEvent {
  if (!isObject(raw)) {
    return { type: "error", message: stringifyUnknown(raw) };
  }
  const message = (raw as { message?: unknown }).message;
  if (typeof message === "string") {
    return { type: "error", message };
  }
  // Some sources put the message under .error.message
  const inner = (raw as { error?: unknown }).error;
  if (isObject(inner)) {
    const innerMessage = (inner as { message?: unknown }).message;
    if (typeof innerMessage === "string") {
      return { type: "error", message: innerMessage };
    }
  }
  return { type: "error", message: "" };
}

// ---------- helpers ----------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeRaw(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return typeof value;
}

function stringifyUnknown(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "";
  }
}
