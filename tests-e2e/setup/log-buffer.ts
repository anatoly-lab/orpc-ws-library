import type { Readable } from "node:stream";
import readline from "node:readline";

/**
 * Default number of log lines retained per container.
 * Chosen so that a typical NestJS boot sequence (~50-100 lines) plus crash trace
 * fits comfortably. Override via E2E_LOG_BUFFER_LINES.
 */
const DEFAULT_BUFFER_LINES = 200;

/**
 * Hard cap on per-line length. Pino error serialization can produce very long
 * single-line JSON payloads with stack traces; we keep those intact up to this
 * cap, then truncate with a marker. Prevents a single misbehaving logger from
 * blowing past the ~500KB worst-case memory budget.
 */
const MAX_LINE_BYTES = 8 * 1024;

function resolveBufferSize(): number {
  const raw = process.env.E2E_LOG_BUFFER_LINES;
  if (!raw) return DEFAULT_BUFFER_LINES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BUFFER_LINES;
}

/**
 * Verbose mode: mirror buffered lines to stdout as they arrive.
 * Enabled when actively debugging — day-to-day runs stay silent.
 * Matches existing testcontainers DEBUG conventions (DEBUG=testcontainers*).
 */
function isVerboseMode(): boolean {
  if (process.env.E2E_VERBOSE === "1") return true;
  const debug = process.env.DEBUG ?? "";
  // Match DEBUG=e2e, DEBUG=e2e:*, DEBUG=e2e*, DEBUG=*
  return /(^|,)(\*|e2e(:?\*)?)($|,)/.test(debug);
}

/**
 * A bounded ring buffer of log lines for a single container.
 *
 * Lifecycle:
 *   1. Instantiate with a service name.
 *   2. Pass `consumer` to `GenericContainer.withLogConsumer(...)` BEFORE `.start()`.
 *      testcontainers invokes it with a Readable once the container is running,
 *      regardless of whether the wait strategy ultimately succeeds — so we
 *      always capture the boot-crash window.
 *   3. On startup success: caller invokes `discard()` (or does nothing — buffer
 *      just gets GC'd with the service starter scope, and registry is cleared
 *      in bulk).
 *   4. On startup failure: caller invokes `dump()` to flush to stdout BEFORE
 *      the container is reaped.
 *
 * Why a class over a function-returning-object: three methods share mutable
 * state (lines array, attached stream, detached flag) — a class makes the
 * contract explicit and keeps the registry typed cleanly.
 */
export class ContainerLogBuffer {
  private readonly lines: string[] = [];
  private readonly maxLines: number;
  private readonly verbose: boolean;
  private stream: Readable | null = null;
  private reader: readline.Interface | null = null;
  private detached = false;

  constructor(
    readonly serviceName: string,
    options?: { maxLines?: number; verbose?: boolean },
  ) {
    this.maxLines = options?.maxLines ?? resolveBufferSize();
    this.verbose = options?.verbose ?? isVerboseMode();
  }

  /**
   * The function to pass to `GenericContainer.withLogConsumer()`.
   * Bound so that callers can pass `buffer.consumer` directly without
   * rebinding `this`.
   */
  readonly consumer = (stream: Readable): void => {
    // Defensive: if the container is started more than once (shouldn't happen
    // in our setup, but the API allows re-invocation), drop the older stream.
    if (this.stream) {
      this.teardownStream();
    }

    this.stream = stream;

    // readline handles CR/LF across chunk boundaries — same approach testcontainers
    // uses internally (they use `byline`, a functional equivalent).
    this.reader = readline.createInterface({
      input: stream,
      // crlfDelay: Infinity so \r\n is treated as a single line break
      crlfDelay: Infinity,
    });

    this.reader.on("line", (line) => {
      // Truncate overlong lines so a single megabyte JSON log can't blow the
      // memory budget. Keeps stack traces intact up to MAX_LINE_BYTES.
      const safe =
        Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES
          ? line.slice(0, MAX_LINE_BYTES) + " [truncated]"
          : line;

      this.lines.push(safe);
      if (this.lines.length > this.maxLines) {
        // Drop oldest. O(n) but n <= maxLines so it's bounded; for 200 lines
        // this is faster and simpler than a circular buffer.
        this.lines.shift();
      }

      if (this.verbose) {
        // Prefix so interleaved streams are readable.
        process.stdout.write(`[${this.serviceName}] ${safe}\n`);
      }
    });

    // Stream errors would otherwise become unhandled; swallow them — we're
    // best-effort, and the real failure will surface through the wait strategy.
    stream.on("error", () => {
      // no-op: we don't want to add noise on graceful container stop
    });
  };

  /**
   * Flush all buffered lines to stdout with a framed header.
   * Safe to call even if the stream never produced any data.
   */
  dump(): void {
    const header = `=== Logs from failed container: ${this.serviceName} (last ${this.lines.length}/${this.maxLines}) ===`;
    process.stdout.write(`\n${header}\n`);
    if (this.lines.length === 0) {
      process.stdout.write(
        `(no log output captured before failure — container may have died before emitting anything, or before our log consumer attached)\n`,
      );
    } else {
      for (const line of this.lines) {
        process.stdout.write(`[${this.serviceName}] ${line}\n`);
      }
    }
    process.stdout.write(`${"=".repeat(header.length)}\n`);
  }

  /**
   * Detach from the log stream without flushing. Called on happy path to free
   * resources and ensure Node doesn't keep the process alive waiting on the
   * stream to end.
   */
  discard(): void {
    this.teardownStream();
    this.lines.length = 0;
  }

  private teardownStream(): void {
    if (this.detached) return;
    this.detached = true;
    try {
      this.reader?.close();
    } catch {
      // ignore
    }
    try {
      // destroy() ends the underlying Docker log stream so the container can
      // be reaped cleanly. Without this, Node can hold the event loop open.
      this.stream?.destroy();
    } catch {
      // ignore
    }
    this.reader = null;
    this.stream = null;
  }
}

/**
 * Module-level registry of active buffers, keyed by service name.
 *
 * Purpose: allows `global-teardown.ts` to surface buffered logs even when the
 * containers have already been reaped by the setup-failure cleanup path —
 * closing the diagnostic blind spot where teardown would previously print
 * "No containers running" and swallow the crash trace.
 */
const registry = new Map<string, ContainerLogBuffer>();

/**
 * Create a new buffer and register it. Callers wire `buffer.consumer` into
 * `.withLogConsumer(...)` before `.start()`.
 */
export function createLogBuffer(serviceName: string): ContainerLogBuffer {
  // If a buffer already exists for this name (e.g., reruns within the same
  // process), discard the old one first.
  registry.get(serviceName)?.discard();
  const buffer = new ContainerLogBuffer(serviceName);
  registry.set(serviceName, buffer);
  return buffer;
}

/**
 * Flush all registered buffers. Called from the setup failure path to surface
 * correlation across services (the service that crashed, plus what its peers
 * were doing at the time).
 */
export function dumpAllBuffers(): void {
  if (registry.size === 0) return;
  for (const buffer of registry.values()) {
    buffer.dump();
  }
}

/**
 * Discard and deregister all buffers. Called on happy-path completion of
 * startContainers so we don't hold references into the container lifetime.
 */
export function discardAllBuffers(): void {
  for (const buffer of registry.values()) {
    buffer.discard();
  }
  registry.clear();
}

/**
 * True when at least one buffer is registered. Used by teardown to decide
 * whether to fall back to buffered output when the live container handles are
 * gone.
 */
export function hasBufferedLogs(): boolean {
  return registry.size > 0;
}
