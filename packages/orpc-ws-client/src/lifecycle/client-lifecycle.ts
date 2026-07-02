// Client lifecycle + terminal-state controller.
//
// Owns the one cohesive cluster of *behavior* that used to live inline in the
// composition root (`createOrpcWsClient`): the three terminal states and the
// connect/dispose lifecycle. Extracting it keeps the composition root to
// wiring (CLAUDE.md "No god files" / "Composition root is the only place
// wires meet") and gives this behavior a single home with one responsibility.
//
// The client has THREE terminal states — `dispose()`, terminal auth failure,
// and `kicked` (session replaced, close 4005) — and the reconnect machinery
// must refuse to run in ALL of them. The first two are latches owned HERE;
// `kicked` lives in the state manager (the 4005 branch in event-handlers.ts
// sets it), read back via `connectionState`.
//
// Forward-reference note: `fireTerminalAuthFailure` / `isDead` are needed by
// the ReconnectManager (constructed BEFORE this controller in the factory),
// while their teardowns need the `SleepDetector` and `ReconnectManager`
// (constructed AFTER). The composition root resolves the cycle by passing
// those later-built collaborators as lazy getters (`getSleepDetector` /
// `getReconnectManager`) — the same deferred-read the old inline closures did
// over their `let` bindings, just across a module boundary. Methods are arrow
// fields so they can be handed to collaborators as plain callbacks
// (`onTerminalAuthFailure`, `onKicked`, `isDead`) without `this`-binding care.

import type { Logger } from "@orpc-ws/shared";

import type { ConnectionStateManager } from "../state/connection-state.js";
import { connecting, disconnected } from "../state/types.js";
import type { WebSocketHolder } from "../state/websocket-holder.js";
import type { LinkFactory } from "../client/link-factory.js";
import type { HeartbeatMonitor } from "../heartbeat/monitor.js";
import type { HeartbeatSubscriber } from "../heartbeat/subscriber.js";
import type { SleepDetector } from "../sleep/sleep-detector.js";
import type { ReconnectManager } from "../reconnect/reconnect-manager.js";
import type { ReconnectConfig } from "../config/reconnect-config.js";
import type { ClientEvent } from "../events.js";

import type { WebSocketFactory } from "./websocket-factory.js";
import type { UrlProvider, WebSocketEventHandlers } from "./types.js";

/**
 * Collaborators the lifecycle controller drives. All constructed by the
 * composition root; the two `get*` thunks defer reads of collaborators built
 * AFTER this controller (see the forward-reference note above).
 */
export interface ClientLifecycleDeps {
  connectionState: ConnectionStateManager;
  websocketHolder: WebSocketHolder;
  linkFactory: LinkFactory;
  heartbeatMonitor: HeartbeatMonitor;
  heartbeatSubscriber: HeartbeatSubscriber;
  websocketFactory: WebSocketFactory;
  reconnectConfig: ReconnectConfig;
  /** Re-invoked by partysocket on every reconnect; resolves the current token. */
  urlProvider: UrlProvider;
  /** Fresh per-wrapper handler triple (closes over the composition root's EventHandlers). */
  createHandlers: () => WebSocketEventHandlers;
  /** Lazy: the detector is built after this controller. */
  getSleepDetector: () => SleepDetector | null;
  /** Lazy: the manager is built after this controller; only `dispose()` reads it. */
  getReconnectManager: () => ReconnectManager;
  emit: (evt: ClientEvent) => void;
  onTerminalAuthFailure?: () => void;
  /**
   * Optional (bidi-on only): retire the bidi mux + s2c host. Invoked on
   * EVERY death path — dispose(), terminal auth failure, kicked — after
   * the wrapper is closed (close-before-dispose: the wrapper's synchronous
   * close fan-out settles in-flight bidi calls first; the handle itself
   * defers `mux.dispose()` to a microtask — see bidi/client-bidi.ts
   * TEARDOWN ORDERING). Idempotent (flag-guarded `makeBidiDispose` +
   * handle-nulling `disposeCurrent`), so overlapping death paths (e.g. a
   * kick followed by dispose()) double-invoking it is safe. Without this,
   * a terminal/kicked client retained the mux + host on the closed
   * wrapper until dispose() or GC.
   */
  disposeBidi?: () => void;
  logger: Logger;
}

export class ClientLifecycle {
  private readonly deps: ClientLifecycleDeps;
  private disposed = false;
  // Single-fire terminal latch (Bug 14): once the library gives up on auth
  // recovery, repeat triggers must not re-fire the consumer callback.
  private terminalAuthFired = false;

  constructor(deps: ClientLifecycleDeps) {
    this.deps = deps;
  }

  /**
   * ONE notion of "this client is dead", shared by every reconnect-sensitive
   * collaborator (F1/F3). Wired into BOTH the ReconnectManager (entry-point +
   * after-await short-circuits) and the TokenRefreshHandler (last line of
   * defense at the socket swap). The first two terminal states are latches
   * here; `kicked` lives in the state manager (4005 branch in
   * event-handlers.ts). Pre-fix only `disposed || terminalAuthFired` was
   * checked: a reconnect armed before a 4005 (heartbeat-timeout debounce /
   * in-flight refresh) completed AFTER the kick, swapped in a new socket, and
   * `handleOpen` flipped `kicked` back to `connected` — stealing the session
   * back from the tab that legitimately replaced it.
   */
  isDead = (): boolean =>
    this.disposed ||
    this.terminalAuthFired ||
    this.deps.connectionState.getState().status === "kicked";

  /**
   * Single-fire terminal teardown (Bug 14). The public contract
   * (`onTerminalAuthFailure`) says the client is TERMINAL after this fires —
   * previously nothing made that true: the partysocket wrapper kept
   * auto-retrying with the stale token, every rejected retry re-fired the
   * consumer callback, and state stayed `disconnected({willRetry: true})`
   * forever.
   *
   * Both terminal triggers route here: the ReconnectManager (refresh returned
   * null / storm guard tripped — it has its own internal single-fire latch)
   * and the no-tokenProvider auth-recovery branch. This carries the
   * composition-level latch so the two paths together fire the consumer
   * callback at most once per client.
   *
   * Teardown ordering (CLEAR-BEFORE-CLOSE — fixes the spurious-emit bug):
   * capture the wrapper, then null the link + holder BEFORE calling
   * `ws.close()`. partysocket 1.2.0 dispatches `close` SYNCHRONOUSLY from
   * `close()`, so `ws.close()` re-enters our own `handleClose` inline.
   * With the holder already cleared, that re-entrant close sees
   * `wrapper !== holder.get()` (holder is null) → `decideClose` returns
   * `ignore` (stale-ws, Bug 9 guard) → no state transition, no hooks, no
   * spurious `auth_failure{refreshable:true}` / transient
   * `disconnected{willRetry:true}`. (Pre-fix the holder was still set when
   * we closed, so on a never-opened connection the re-entrant close hit
   * the Bug-4 branch `code===1000 && !attemptHadOpened → auth-recovery`
   * and emitted a contradictory non-terminal frame before our terminal
   * emit below.) orpc's cleanup still happens because its close listener
   * is on the WRAPPER, not our holder: `ws.close()` → orpc `peer.close()`
   * (frameless) ends the heartbeat stream. We then `drop()` the subscriber
   * (NOT `abort()`) to release our refs without firing an abort-send onto
   * the now-closed socket.
   */
  fireTerminalAuthFailure = (): void => {
    if (this.terminalAuthFired) {
      this.deps.logger.debug(
        "orpc-ws-client: terminal auth failure already handled; ignoring repeat",
      );
      return;
    }
    this.terminalAuthFired = true;

    // Stop the monitor + sleep detector up front (cheap, send-free).
    // Terminal means ALL background machinery stops (F3). Pre-fix the sleep
    // detector kept ticking, so a post-terminal wake still emitted
    // `woke_from_sleep` and ran the full reconnect machinery just to be
    // refused at the socket swap.
    this.deps.heartbeatMonitor.stop();
    const sleepDetector = this.deps.getSleepDetector();
    if (sleepDetector) sleepDetector.stop();

    // CLEAR the link + holder BEFORE closing the wrapper. partysocket's
    // synchronous close (1.2.0) re-enters `handleClose` inline; with the
    // holder nulled first, that re-entrant close is recognized as stale
    // (Bug 9 guard) and ignored — no spurious emit. See the method doc.
    const ws = this.deps.websocketHolder.get();
    this.deps.linkFactory.clearLink();
    this.deps.websocketHolder.clear();
    if (ws) {
      try {
        ws.close();
      } catch (err) {
        this.deps.logger.warn(
          "orpc-ws-client: ws.close() during terminal auth failure threw",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }
    // `drop()` (not `abort()`): the socket is now closed and orpc's wrapper
    // close-listener has already torn the stream down framelessly. We only
    // release our references here. See HeartbeatSubscriber.drop().
    this.deps.heartbeatSubscriber.drop();
    // Retire the bidi handle (bidi-on only) — the wrapper close above ran
    // its synchronous fan-out, so this honors close-before-dispose.
    this.deps.disposeBidi?.();

    // Terminal state BEFORE the consumer callback — the contract in
    // auth/types.ts promises the connection has already moved to a
    // non-retrying disconnected state when the callback runs.
    this.deps.connectionState.setState(disconnected({ willRetry: false }));

    this.deps.emit({ type: "auth_failure", refreshable: false });
    if (this.deps.onTerminalAuthFailure) {
      try {
        this.deps.onTerminalAuthFailure();
      } catch (err) {
        this.deps.logger.error(
          "orpc-ws-client: onTerminalAuthFailure callback threw",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }
  };

  /**
   * Kicked teardown (F1/F3) — mirrors the terminal/dispose teardowns for the
   * session-replaced case. The 4005 branch in event-handlers.ts already
   * closed the wrapper (latching partysocket's `_closeCalled` so auto-retry
   * stops) and its onClose hook already stopped the heartbeat; what was
   * MISSING was clearing the link/holder — so a late stale open from the
   * closed wrapper is dropped by the Bug 6/17 guard (holder is null) — and
   * stopping the sleep detector, so a wake on a kicked client neither emits
   * `woke_from_sleep` nor spins up reconnect machinery. The bidi handle is
   * retired too (the 4005 close already ran the wrapper's fan-out, so
   * close-before-dispose holds) — kicked is terminal, and without this the
   * mux + s2c host stayed registered on the closed wrapper until dispose()
   * or GC. All calls are idempotent; a later `dispose()` re-running them is
   * safe.
   */
  handleKicked = (): void => {
    this.deps.linkFactory.clearLink();
    this.deps.websocketHolder.clear();
    const sleepDetector = this.deps.getSleepDetector();
    if (sleepDetector) sleepDetector.stop();
    this.deps.disposeBidi?.();
  };

  /**
   * Idempotent. Initiates the first WebSocket connection if not already
   * connecting / connected. The library owns all subsequent reconnect logic.
   * No-op in terminal states (disposed / terminal auth / kicked).
   */
  connect = (): void => {
    if (this.disposed) {
      this.deps.logger.warn(
        "orpc-ws-client: connect() called after dispose(); ignoring",
      );
      return;
    }
    if (this.terminalAuthFired) {
      // Terminal auth failure is a one-way door (Bug 14): the state is
      // `disconnected({willRetry: false})`, which is also the
      // pre-first-connect state, so the latch — not the state — is what
      // distinguishes "never connected" from "library gave up". Per the
      // contract the consumer creates a NEW client post-re-auth.
      this.deps.logger.warn(
        "orpc-ws-client: connect() after terminal auth failure; ignoring — create a new client",
      );
      return;
    }
    const s = this.deps.connectionState.getState();
    // Idempotency / terminal-state guards.
    if (
      s.status === "connecting" ||
      s.status === "connected" ||
      s.status === "kicked"
    ) {
      return;
    }
    // Bug 13: the status guard above misses the auto-retry window. After any
    // drop the state is `disconnected({willRetry: true})` while the EXISTING
    // partysocket wrapper is still retrying internally (default maxRetries:
    // Infinity). Creating a second wrapper here would overwrite the holder
    // reference and orphan the old wrapper — never closed, reconnecting
    // forever; with the server's singleConnectionPerUser the two perpetually
    // 4005-kick each other. A wrapper in the holder means the library already
    // owns reconnect; the idempotent behavior is to leave it alone. (The
    // dispose and terminal-auth teardowns both clear the holder, so those
    // paths never reach this guard — their latches above return first anyway.)
    if (this.deps.websocketHolder.get() !== null) {
      this.deps.logger.debug(
        "orpc-ws-client: connect() ignored — a connection already exists; the library owns reconnect",
      );
      return;
    }
    // Move to connecting BEFORE creating the WS so the very first subscriber
    // tick reflects the right state.
    this.deps.connectionState.setState(connecting());

    const ws = this.deps.websocketFactory.create(
      this.deps.urlProvider,
      this.deps.createHandlers(),
      this.deps.reconnectConfig,
    );
    this.deps.websocketHolder.set(ws);

    const sleepDetector = this.deps.getSleepDetector();
    if (sleepDetector && !sleepDetector.isRunning()) {
      sleepDetector.start();
    }
  };

  /**
   * Terminal teardown. Closes the WS, stops all timers and watchers, releases
   * resources. After `dispose()` the client is dead; the caller creates a new
   * client to reconnect.
   */
  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;

    // Stop background work first so a tick mid-teardown can't reach a
    // half-disposed collaborator. The reconnect manager goes down with them
    // (Bug 12): an armed debounce timer or in-flight refresh would otherwise
    // fire AFTER this teardown and resurrect a zombie socket.
    this.deps.getReconnectManager().dispose();
    this.deps.heartbeatMonitor.stop();
    const sleepDetector = this.deps.getSleepDetector();
    if (sleepDetector) sleepDetector.stop();

    // CLEAR-BEFORE-CLOSE (same discipline as fireTerminalAuthFailure):
    // capture the wrapper, null the link + holder, THEN close. partysocket
    // 1.2.0 dispatches `close` synchronously, re-entering `handleClose`
    // inline; with the holder already null the re-entrant close is
    // stale-dropped (Bug 9 guard) — no spurious transient
    // `disconnected{willRetry:true}` frame before the terminal state below.
    // orpc's wrapper close-listener (`peer.close()`) still ends the
    // heartbeat AsyncIterable framelessly because it's bound to the
    // WRAPPER, not our holder. We then `drop()` (not `abort()`) to release
    // our refs without an abort-send onto the closed socket — see
    // HeartbeatSubscriber.drop() for the mechanism.
    const ws = this.deps.websocketHolder.get();
    this.deps.linkFactory.clearLink();
    this.deps.websocketHolder.clear();
    if (ws) {
      try {
        ws.close();
      } catch (err) {
        // Best-effort: a partysocket already in a bad state may throw.
        this.deps.logger.warn("orpc-ws-client: ws.close() during dispose threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Release our heartbeat references. Idempotent belt-and-braces: the
    // onClose hook already ran `drop()` if a socket existed; this also
    // covers the no-socket dispose.
    this.deps.heartbeatSubscriber.drop();

    // Terminal state. `willRetry: false` distinguishes this from partysocket's
    // auto-retry path (which would be willRetry: true).
    this.deps.connectionState.setState(disconnected({ willRetry: false }));

    // Retire the bidi handle LAST (bidi-on only) — the wrapper was closed
    // above, so close-before-dispose holds; idempotent when a terminal /
    // kicked path already retired it.
    this.deps.disposeBidi?.();
  };
}
