// Heartbeat tunables — interval, watchdog timeout, and the WS-protocol
// ping/pong opt-out.
//
// All three numerics are configurable per CLAUDE.md "Configurable, not
// hardcoded". The defaults match the source `WebSocketGateway` —
// `WS_HEARTBEAT_INTERVAL_MS=25000` and `WS_HEARTBEAT_TIMEOUT_MS=20000` —
// preserving production behavior on day one.
//
// Two distinct windows because the dual-channel design separates the
// concerns (see CLAUDE.md "Heartbeat ownership"):
//   - `intervalMs` — how often the ORPC `ping` event AND the WS
//     `ws.ping()` frame fire. Same cadence so a single timer drives both.
//   - `timeoutMs` — the client's watchdog grace period. Server emits
//     `config` with both numbers; client computes its own deadline.
//
// `pingPong` is the kill switch for the WS-protocol channel. We keep it
// on by default (Bug 6 mitigation) but allow opting out for environments
// where the ping/pong frames are problematic (some proxies eat them, or
// tests that want pure ORPC-channel testing).

export interface HeartbeatConfig {
  /**
   * Cadence for BOTH the ORPC heartbeat publisher AND the WS-protocol
   * `ws.ping()` watchdog. One timer drives both — keeping them in lockstep
   * is cheaper than two independent timers and avoids drift.
   */
  intervalMs: number;
  /**
   * Server-advertised watchdog deadline. The client receives this in the
   * initial `config` event and uses it as `intervalMs + timeoutMs` to
   * decide when a missed ping should fire its `onTimeout` callback.
   */
  timeoutMs: number;
  /**
   * Whether to run the WS-protocol-level ping/pong watchdog
   * (`ws.ping()` + browser's auto-pong + zombie termination). Defaults to
   * `true` — Bug 6 fix relies on it for proxy keep-alive + zombie
   * detection. Disable only if the ORPC channel alone suffices.
   */
  pingPong: boolean;
}

/**
 * Defaults match the source gateway's production behavior:
 * 25s interval (proxy keep-alive friendly), 20s timeout (client gives
 * up after roughly 45s of silence), ping/pong on.
 */
export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  intervalMs: 25_000,
  timeoutMs: 20_000,
  pingPong: true,
};
