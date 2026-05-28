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
