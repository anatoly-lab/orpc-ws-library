// Token-refresh handler.
//
// Phase 1.3 lift from
// `apps/web/src/lib/websocket/reconnect/token-refresh-handler.ts`.
//
// Differences from the source (de-app-ification):
//   1. No module-level singleton — class export. The composition root
//      (Phase 1.7) instantiates it; tests construct their own.
//   2. `authStorage: typeof AuthStorageType` → `tokenProvider: TokenProvider`.
//      The source's `getValidAccessToken()` returned cached-if-fresh-else-
//      refreshed; we deliberately drop that conflation. Storm guard
//      (ReconnectManager) decides WHETHER to call refresh; when called,
//      `tokenProvider.refresh()` always actually refreshes.
//   3. `authStorage.getAccessToken()` (inside the URL provider closure) →
//      `tokenProvider.getToken()`. The Bug-1 mitigation is preserved
//      verbatim — the URL provider is a closure re-invoked by partysocket
//      on every reconnect, so each retry reads the latest token.
//   4. `buildWebSocketUrl` is now constructor-injected as `urlBuilder`. The
//      library doesn't own URL construction (the consumer's server might
//      live anywhere); Phase 1.7's `url-builder.ts` will supply the default.
//   5. Heartbeat monitor / subscriber stops are OPTIONAL — Phase 1.5 lifts
//      the concrete classes. We accept the minimal `{ stop(): void }` shape
//      and call it iff injected. The interface stays inline so Phase 1.5
//      can supply concrete classes without breaking this file's typing.
//   6. `console.log` → injected `Logger` (CLAUDE.md "Zero `console.log`").
//
// The internal mutex (`reconnectInProgress`) is preserved verbatim. The
// design doc warns that concurrent `reconnectWithNewToken` calls would race
// holder.set() / linkClearer / handler attachment; the mutex bails on the
// second caller with a warn log.

import { type Logger, noopLogger } from "@orpc-ws/shared";

import type { WebSocketFactory } from "../lifecycle/websocket-factory.js";
import type {
  ReconnectConfig,
  UrlProvider,
  WebSocketEventHandlers,
} from "../lifecycle/types.js";
import type { ConnectionStateManager } from "../state/connection-state.js";
import { disconnected } from "../state/types.js";
import type { WebSocketHolder } from "../state/websocket-holder.js";

import type { TokenProvider } from "../auth/token-provider.js";

/**
 * Minimal "can be stopped" interface. Phase 1.5's HeartbeatMonitor and
 * HeartbeatSubscriber both implement this shape; declared inline here so
 * Phase 1.3 doesn't take a dep on Phase 1.5's concrete classes. The
 * composition root will pass the real instances; tests pass stubs.
 *
 * NOTE: the source called `heartbeatSubscriber.unsubscribe()` distinct from
 * `heartbeatMonitor.stop()`. Both effectively mean "stop emitting / watching";
 * we collapse to a single `stop()` here for symmetry — Phase 1.5's classes
 * expose `stop()` as the canonical "tear down all timers/subscriptions".
 */
interface Stoppable {
  stop(): void;
}

/**
 * Dependencies for TokenRefreshHandler. All injected at construction;
 * fields are intentionally not bundled into a single "deps" object on the
 * instance (we destructure into readonly fields) so each call site reads as
 * `this.tokenProvider` not `this.deps.tokenProvider`.
 */
export interface TokenRefreshHandlerDeps {
  tokenProvider: TokenProvider;
  websocketHolder: WebSocketHolder;
  websocketFactory: WebSocketFactory;
  /**
   * Builds the connection URL from the current token. Phase 1.7 supplies the
   * default impl (`url-builder.ts`) which falls back to no-query-param when
   * the token is null (cookie-auth-ready, CLAUDE.md "Token transport").
   */
  urlBuilder: (token: string | null) => string;
  /**
   * Fresh WebSocketEventHandlers for the new connection. Called every time
   * we reconnect so the handler can re-bind to the new wrapper. Phase 1.7
   * wires this to `EventHandlers.createHandlers(newWs)`.
   */
  getEventHandlers: () => WebSocketEventHandlers;
  reconnectConfig: ReconnectConfig;
  /**
   * Phase 1.5 — concrete HeartbeatMonitor. Optional in Phase 1.3 so the
   * test suite can omit it without forcing a stub. The composition root
   * always provides one.
   */
  heartbeatMonitor?: Stoppable | undefined;
  /**
   * Phase 1.5 — concrete HeartbeatSubscriber. Same shape, same rationale.
   */
  heartbeatSubscriber?: Stoppable | undefined;
  /**
   * Called to invalidate any cached ORPC `RPCLink` instance, so the next
   * RPC call constructs a fresh link against the new WebSocket. Phase 1.4
   * wires this to `LinkFactory.clear()`.
   */
  linkClearer: () => void;
  /**
   * Bug 12 / F1 belt-and-braces: when this predicate returns `true`, the
   * handler refuses to build/install a new WebSocket. "Dead" covers all
   * THREE terminal states — `dispose()`, terminal auth failure, and
   * `kicked` (session replaced, close 4005); the composition root wires
   * its unified `isDead` predicate so a refresh that resolves after ANY
   * death cannot resurrect a connection. Optional — tests and the
   * ReconnectManager's own deadness checks are the primary guards; this
   * is the last line of defense at the swap.
   */
  isDead?: () => boolean;
  /**
   * Connection-state manager — OPTIONAL, wired by the composition root.
   * The Bug-21 CLEAR-BEFORE-CLOSE fix stale-drops the old wrapper's own
   * close event, so a swap tearing down an OPENED wrapper (sleep-wake
   * reconnect / upload-401 recovery — both can arrive while state is
   * `connected`) would otherwise emit NO disconnected frame at all:
   * `client.state` would keep claiming `connected` over a dead link until
   * the NEW socket opens — indefinitely, if the server is down. swapSocket
   * mirrors the heartbeat-timeout path (Bug 15): guarded on `connected`,
   * it sets `disconnected({ willRetry: true })` at swap start. Optional so
   * unit harnesses that don't observe state can omit it.
   */
  connectionState?: ConnectionStateManager;
  logger?: Logger;
}

/**
 * Owns the "refresh token, then swap out the WebSocket" half of the
 * reconnect flow. Called by ReconnectManager after the storm-guard window
 * decides a refresh is allowed (Phase 1.3 ReconnectManager.tryAuthRecovery).
 *
 * Single responsibility: turn "we need a fresh token" into "we have a fresh
 * token AND a new WS attached to it AND the heartbeat / link cache cleared".
 * The orchestrator (ReconnectManager) owns timing; this class owns the
 * concrete swap.
 */
export class TokenRefreshHandler {
  private readonly tokenProvider: TokenProvider;
  private readonly websocketHolder: WebSocketHolder;
  private readonly websocketFactory: WebSocketFactory;
  private readonly urlBuilder: (token: string | null) => string;
  private readonly getEventHandlers: () => WebSocketEventHandlers;
  private readonly reconnectConfig: ReconnectConfig;
  private readonly heartbeatMonitor: Stoppable | undefined;
  private readonly heartbeatSubscriber: Stoppable | undefined;
  private readonly linkClearer: () => void;
  private readonly isDead: (() => boolean) | undefined;
  private readonly connectionState: ConnectionStateManager | undefined;
  private readonly logger: Logger;

  /**
   * Mutex flag. Source verbatim semantics: bail (with a warn log) if a
   * second `reconnectWithNewToken` arrives while the first is still in
   * flight. Without this, holder.set() / linkClearer / handler re-binding
   * would race and we'd end up with mismatched references.
   */
  private reconnectInProgress = false;

  /**
   * Single-flight memo for `tokenProvider.refresh()` (Bug 16 / BUG-5).
   * Two concurrent refresh-driving paths (heartbeat-timeout `reconnect()`
   * racing a 1008-triggered `tryAuthRecovery`) must never issue two
   * network refresh calls: with IdP refresh-token rotation (Keycloak reuse
   * detection), concurrent reuse of the same refresh token revokes the
   * whole session — a self-inflicted logout. The swap mutex above does NOT
   * cover this (it guards only the synchronous swap, not the awaited
   * network call), so the coalescing happens here at the refresh itself.
   */
  private refreshInFlight: Promise<string | null> | null = null;

  constructor(deps: TokenRefreshHandlerDeps) {
    this.tokenProvider = deps.tokenProvider;
    this.websocketHolder = deps.websocketHolder;
    this.websocketFactory = deps.websocketFactory;
    this.urlBuilder = deps.urlBuilder;
    this.getEventHandlers = deps.getEventHandlers;
    this.reconnectConfig = deps.reconnectConfig;
    this.heartbeatMonitor = deps.heartbeatMonitor;
    this.heartbeatSubscriber = deps.heartbeatSubscriber;
    this.linkClearer = deps.linkClearer;
    this.isDead = deps.isDead;
    this.connectionState = deps.connectionState;
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * Refresh the token and (if a new token came back) kick off the WebSocket
   * swap. Returns:
   *   - `true` when a fresh token was obtained AND `reconnectWithNewToken`
   *     was invoked. (The actual reconnect is fire-and-forget from the
   *     orchestrator's perspective — partysocket's reconnect loop owns the
   *     handshake.)
   *   - `false` when `tokenProvider.refresh()` returned null. The caller
   *     (ReconnectManager) is responsible for emitting `onTerminalAuthFailure`.
   *
   * Does NOT take the mutex — the mutex only covers the actual swap, since
   * `refresh()` is a network call that could happen during a swap-in-progress
   * (e.g. proactive refresh racing a reactive one). The swap itself is
   * mutex-protected so concurrent `reconnectWithNewToken` calls serialize.
   * The refresh itself IS single-flighted (`refreshTokenOnce`) so concurrent
   * callers share one network call and one outcome.
   */
  async refreshAndReconnect(): Promise<boolean> {
    const token = await this.refreshTokenOnce();
    if (token === null) {
      this.logger.warn(
        "token-refresh-handler: tokenProvider.refresh() returned null",
      );
      return false;
    }
    this.reconnectWithNewToken(token);
    return true;
  }

  /**
   * Single-flight wrapper around `tokenProvider.refresh()` (Bug 16 / BUG-5).
   * While a refresh is in flight, every additional caller awaits the SAME
   * promise — the IdP sees exactly one request per flight. The memo clears
   * in `finally` so the NEXT storm-guard-approved refresh starts fresh
   * (success and failure alike; a settled promise must not be served stale).
   *
   * `refresh()` is invoked EAGERLY (synchronously, on the first caller of a
   * flight) — same call timing as the pre-single-flight
   * `await tokenProvider.refresh()`. `Promise.resolve(...)` normalizes the
   * result; the `try/catch` keeps a (contract-violating) synchronous throw
   * from poisoning the memo — it rejects that attempt and leaves the slot
   * clear for the next one.
   */
  private refreshTokenOnce(): Promise<string | null> {
    if (!this.refreshInFlight) {
      try {
        this.refreshInFlight = Promise.resolve(
          this.tokenProvider.refresh(),
        ).finally(() => {
          this.refreshInFlight = null;
        });
      } catch (err) {
        this.refreshInFlight = null;
        return Promise.reject(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
    return this.refreshInFlight;
  }

  /**
   * Whether a `tokenProvider.refresh()` flight is currently pending (F2).
   * The ReconnectManager's auth-recovery path reads this to JOIN an
   * in-flight refresh (its `refreshAndReconnect` call lands on the same
   * single-flight memo above) instead of counting the duplicate trigger
   * against the storm guard. Without the join, partysocket's double-fired
   * `onclose` (one 1008 → two `tryAuthRecovery` calls ~1ms apart) tripped
   * the guard → terminal while the first call's refresh was still in
   * flight and about to succeed — a spurious forced logout.
   */
  isRefreshing(): boolean {
    return this.refreshInFlight !== null;
  }

  /**
   * Tear down the current connection and stand up a new one carrying
   * `newToken`. See `swapSocket` for the mechanics and guards.
   */
  reconnectWithNewToken(newToken: string): void {
    this.swapSocket(newToken);
  }

  /**
   * Reconnect WITHOUT a refresh — rebuild the socket with whatever token is
   * current. Used when the storm window says we refreshed recently (the
   * cached token is still fresh; hitting the IdP again would violate the
   * "single window across all triggers" contract — Bug 16 / BUG-5), or when
   * there is no tokenProvider at all (cookie auth: `getToken()` is the
   * stub's `null`, and the URL builder already handles a null token).
   * Same dispose/mutex guards as the refresh path, via `swapSocket`.
   */
  reconnectWithCurrentToken(): void {
    this.swapSocket(this.tokenProvider.getToken());
  }

  /**
   * The socket swap shared by both reconnect entry points, in order: clear
   * the cached link + holder, record `token` as current, drop a truthful
   * `disconnected` frame if state still claims `connected` (Bug 15 parity —
   * see `TokenRefreshHandlerDeps.connectionState`), close the old wrapper
   * (CLEAR-BEFORE-CLOSE — see the inline comment, Bug 21), re-check
   * deadness (Bug 22) and re-entrant-connect occupancy (Bug 13) after the
   * synchronous close fan-out, and only then install a fresh WS. The new WS
   * uses a URL provider closure (NOT a static URL), so partysocket's
   * internal reconnect loop re-reads `tokenProvider.getToken()` on every
   * retry — this is the Bug-1 (stale-token-after-sleep) mitigation.
   *
   * Mutex-protected. If called while a previous swap is still in flight,
   * the second call is dropped with a warn log.
   */
  private swapSocket(token: string | null): void {
    if (this.isDead?.()) {
      // Bug 12 / F1: a refresh that resolved after the client died —
      // dispose(), terminal auth failure, or a 4005 kick — must not
      // stand up a new WebSocket. The client object is dead.
      this.logger.warn(
        "token-refresh-handler: client is dead (disposed/terminal/kicked); refusing to create a new WebSocket",
      );
      return;
    }
    if (this.reconnectInProgress) {
      this.logger.warn(
        "token-refresh-handler: reconnect already in progress, skipping socket swap",
      );
      return;
    }

    this.reconnectInProgress = true;
    try {
      // Stop heartbeat first so a tick can't fire mid-swap (and find a
      // half-attached WS). Both stops are optional — Phase 1.5 supplies the
      // concrete classes; this code is forward-compatible.
      this.heartbeatSubscriber?.stop();
      this.heartbeatMonitor?.stop();

      // CLEAR-BEFORE-CLOSE (Bug 21) — same discipline as
      // `ClientLifecycle.dispose()` / `fireTerminalAuthFailure()`: capture
      // the wrapper, null the link + holder, THEN close. partysocket 1.3.0
      // dispatches `close` SYNCHRONOUSLY from `close()` — and for a
      // mid-handshake wrapper it synthesizes a pre-open code-1000 close —
      // so closing while the holder still pointed at the wrapper re-entered
      // `handleClose` inline as the CURRENT socket: the 1000-before-open
      // shape routed to `auth-recovery` (Bug 4 branch) → storm-guard trip →
      // spurious terminal auth failure right after a SUCCESSFUL refresh
      // (under cookie auth: a routine sleep-wake became a force-logout).
      // With the holder cleared first, the re-entrant close fails the
      // wrapper-equality check in the orchestrator (Bug 9 stale-WS guard)
      // and is silently dropped. (A previous comment here claimed the close
      // event fires async — false since partysocket 1.2.0.)
      const ws = this.websocketHolder.get();
      // Invalidate the cached RPCLink so the next ORPC call re-creates one
      // against the new WS. Phase 1.4 implements LinkFactory.clear().
      this.linkClearer();
      this.websocketHolder.clear();
      // Stamp the FRESH token BEFORE the close (Bug-21 follow-up).
      // `clear()` above resets the holder's token record, and the
      // synchronous close fan-out below runs arbitrary listeners
      // (orpc/bidi abort wiring, consumer code) that may read
      // `getCurrentToken()` or re-enter `client.connect()` (see the holder
      // re-check below) — everything inside the fan-out must see the token
      // this swap is installing, never a null/stale one. (The re-entrant
      // connect()'s URL itself comes from `tokenProvider.getToken()` via
      // the composition root's urlProvider — kept in sync with the refresh
      // result by the TokenProvider contract, Bug 1 — so its socket
      // carries the fresh token either way; this stamp keeps the holder's
      // bookkeeping consistent with it.)
      this.websocketHolder.setCurrentToken(token);

      // State truthfulness at swap start (Bug 15 parity). The clear above
      // makes the old wrapper's close STALE-dropped, so tearing down an
      // OPENED wrapper (sleep-wake reconnect / upload-401 recovery arrive
      // with state `connected`) no longer emits a disconnected frame from
      // the close path — without this transition, `client.state` would
      // claim `connected` over a dead link until the NEW socket opens
      // (indefinitely, if the server is down). Guarded on `connected` —
      // exactly like the heartbeat-timeout path — so we never clobber a
      // truthful `disconnected({code})` frame from a real close (the
      // auth-recovery swaps) or a `connecting` frame.
      const stateManager = this.connectionState;
      if (stateManager && stateManager.getState().status === "connected") {
        stateManager.setState(disconnected({ willRetry: true }));
      }

      if (ws) {
        try {
          ws.close();
        } catch (err) {
          // Best-effort, mirroring dispose(): a wrapper already in a bad
          // state must not abort the swap — the new socket still goes up.
          this.logger.warn(
            "token-refresh-handler: ws.close() during socket swap threw",
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
      }

      // Re-check deadness AFTER the close (Bug 22) — independent of the
      // clear-before-close fix above, deliberately kept as defense in
      // depth: the synchronous close fan-out runs arbitrary listeners on
      // the wrapper (ours plus bidi/orpc/consumer wiring), any of which can
      // dispose the client or drive it terminal/kicked while `close()` is
      // still on the stack. The entry check at the top of this method ran
      // BEFORE the close, so without this re-check the swap would resume,
      // build a new socket, and `handleOpen` would flip state back to
      // `connected` AFTER the consumer was told the client is dead
      // (zombie-after-terminal).
      if (this.isDead?.()) {
        // Keep the dead client's cleared state cleared: the fresh-token
        // stamp above existed for the fan-out's benefit; it must not
        // survive the bail (dispose()/terminal already cleared the holder).
        this.websocketHolder.setCurrentToken(null);
        this.logger.warn(
          "token-refresh-handler: client died during socket swap (disposed/terminal/kicked); refusing to create a new WebSocket",
        );
        return;
      }

      // Holder re-check (Bug-13 re-entrancy, re-opened by the Bug-21 fix).
      // Between `clear()` and `set(newWs)` the holder is null, so the
      // Bug-13 guard in `ClientLifecycle.connect()` ("a wrapper in the
      // holder means the library already owns reconnect") PASSES for a
      // consumer calling `client.connect()` from inside the synchronous
      // close fan-out (orpc/bidi abort listeners run consumer code inline;
      // dispose() and terminal have latches that block connect(), a plain
      // swap has none). That re-entrant connect() already stood up a
      // socket on the FRESH token (its urlProvider reads
      // `tokenProvider.getToken()`). If we now created a SECOND socket,
      // the re-entrant one would be orphaned in the overwritten holder
      // slot — never closed, retrying forever — and under the server's
      // singleConnectionPerUser the two would 4005-kick each other in a
      // loop. The swap's goal — a live socket on the fresh token — is
      // already met; bail instead of duplicating.
      if (this.websocketHolder.get() !== null) {
        this.logger.warn(
          "token-refresh-handler: a connection was established during the socket swap (re-entrant connect()); keeping it instead of creating a duplicate",
        );
        return;
      }

      const newWs = this.websocketFactory.create(
        this.createUrlProvider(),
        this.getEventHandlers(),
        this.reconnectConfig,
      );

      this.websocketHolder.set(newWs);
    } finally {
      this.reconnectInProgress = false;
    }
  }

  isReconnecting(): boolean {
    return this.reconnectInProgress;
  }

  /**
   * Build the URL provider closure. The function form (NOT a static string)
   * is the Bug-1 fix: partysocket re-invokes it on every internal reconnect
   * attempt, so each retry carries the freshest token from the consumer's
   * store. If we passed a static URL here, a token swap during sleep would
   * be invisible to partysocket until the next manual reconnect.
   */
  private createUrlProvider(): UrlProvider {
    return () => {
      const token = this.tokenProvider.getToken();
      // Keep the holder's idea of "current token" in sync with what's
      // actually on the URL. This is read by lifecycle code (e.g. when the
      // server sends a 1008 we want to know which token was in flight).
      this.websocketHolder.setCurrentToken(token);
      return this.urlBuilder(token);
    };
  }
}
