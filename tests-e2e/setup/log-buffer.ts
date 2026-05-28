// Tiny ring buffer for child-process logs.
//
// The demo server runs as a child process during the Playwright run;
// its stdout/stderr would normally be silenced (we don't want it
// interleaved with Playwright's test output on green runs). On failure
// we want the last N kilobytes of server logs surfaced for triage.
//
// Implementation: capped Buffer-style list, total-byte budget. When
// writes overflow, oldest chunks drop. `flush()` joins and returns;
// callers typically print to stderr.

export class LogBuffer {
  private readonly chunks: string[] = [];
  private totalBytes = 0;

  constructor(
    private readonly label: string,
    private readonly maxBytes = 64 * 1024,
  ) {}

  write(chunk: string | Buffer): void {
    const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.chunks.push(str);
    this.totalBytes += str.length;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift();
      if (dropped) this.totalBytes -= dropped.length;
    }
  }

  flush(): string {
    if (this.chunks.length === 0) return `[${this.label}] <no output>`;
    return `[${this.label}]\n${this.chunks.join("")}`;
  }

  clear(): void {
    this.chunks.length = 0;
    this.totalBytes = 0;
  }
}
