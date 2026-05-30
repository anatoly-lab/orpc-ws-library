// Logger seam.
//
// Shape is intentionally a structured-args subset of Pino (msg + meta), so a
// consumer can pass a real Pino logger directly. We don't take Pino as a
// peer dependency — the consumer brings their own (or accepts the noop).

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Default logger that drops everything. The library NEVER writes to the
 * console on its own (see CLAUDE.md "Zero console.log"). Consumers opt in
 * to logging by passing their own implementation.
 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Logger bridges
// ---------------------------------------------------------------------------
//
// Tiny adapter factories that let consumers plug common logger shapes into
// the `Logger` seam without writing a 4-line object literal at every call
// site. They are intentionally consumer-facing helpers — they live in
// `@repo/orpc-ws-shared` so both the client core and the server core can
// re-export them, but the library's own internals still depend on the
// `Logger` interface, never on these concretions.

/**
 * Bridge to the global `console`. Universal — works in browsers and Node.
 *
 * The `console.*` calls below are intentional: this IS the bridge. CLAUDE.md's
 * "Zero `console.log`" rule applies to library internals, not to opt-in
 * helpers consumers wire up themselves.
 *
 * @param prefix optional string prepended as `[prefix] ` to every message.
 *   Handy when several subsystems share the devtools console.
 */
export function consoleLogger(prefix?: string): Logger {
  const tag = prefix ? `[${prefix}] ` : "";
  /* eslint-disable no-console -- this IS the console bridge */
  return {
    debug: (msg, meta) => console.debug(tag + msg, meta ?? ""),
    info: (msg, meta) => console.info(tag + msg, meta ?? ""),
    warn: (msg, meta) => console.warn(tag + msg, meta ?? ""),
    error: (msg, meta) => console.error(tag + msg, meta ?? ""),
  };
  /* eslint-enable no-console */
}

/**
 * Duck-typed shape of a Pino logger (and most Pino-compatible loggers like
 * `pino-http`, `roarr`, etc.). We avoid taking Pino as a dep — the consumer
 * brings their own instance and we type against this structural subset.
 *
 * Pino's signature is `(obj, msg?, ...args)` — **object first, message
 * second** — the inverse of our seam.
 */
export interface PinoShape {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Adapt a Pino-style logger to our `Logger` seam. Swaps the (msg, meta) order
 * when meta is present so the underlying logger sees its native (obj, msg)
 * order and emits structured logs correctly.
 */
export function fromPinoShape(logger: PinoShape): Logger {
  return {
    debug: (msg, meta) =>
      meta ? logger.debug(meta, msg) : logger.debug(msg),
    info: (msg, meta) =>
      meta ? logger.info(meta, msg) : logger.info(msg),
    warn: (msg, meta) =>
      meta ? logger.warn(meta, msg) : logger.warn(msg),
    error: (msg, meta) =>
      meta ? logger.error(meta, msg) : logger.error(msg),
  };
}

/**
 * Duck-typed shape of a NestJS `Logger` (`@nestjs/common`). Notable quirks
 * vs. Pino: Nest uses `log` instead of `info`, and accepts a single value
 * (string or structured object) per call rather than `(meta, msg)`.
 *
 * Typed structurally so the shared package stays free of `@nestjs/common`.
 */
export interface NestShape {
  debug(message: unknown, ...optionalParams: unknown[]): void;
  log(message: unknown, ...optionalParams: unknown[]): void;
  warn(message: unknown, ...optionalParams: unknown[]): void;
  error(message: unknown, ...optionalParams: unknown[]): void;
}

/**
 * Adapt a NestJS `Logger` to our `Logger` seam. Merges `meta` into a single
 * `{ msg, ...meta }` payload so Nest's default formatter can render both,
 * and routes `info` → Nest's `log` (Nest has no `info` method).
 */
export function fromNestShape(logger: NestShape): Logger {
  return {
    debug: (msg, meta) => logger.debug(meta ? { msg, ...meta } : msg),
    info: (msg, meta) => logger.log(meta ? { msg, ...meta } : msg),
    warn: (msg, meta) => logger.warn(meta ? { msg, ...meta } : msg),
    error: (msg, meta) => logger.error(meta ? { msg, ...meta } : msg),
  };
}
