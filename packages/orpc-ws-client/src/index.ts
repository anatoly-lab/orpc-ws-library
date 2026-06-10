// Public surface of @repo/orpc-ws-client — the composition root.
//
// Phase 1.7 wires every class from sub-phases 1.1–1.6 into one factory
// function. The factory shape mirrors the design-doc-locked API
// (CLAUDE.md §"Client lifecycle API" + §"State vs events"):
//
//   - `connect()` / `dispose()` — two-method lifecycle. No
//     `disconnect()` / `reconnect()` triplet.
//   - `state` carries the tagged-record `ConnectionState`. Reactive UI
//     subscribes via `state.subscribe(cb)` + reads via `state.getState()`.
//   - `onEvent(evt)` is notifications-only — auth failures, heartbeat
//     timeout, wake-from-sleep. State transitions do NOT come through this
//     channel.
//   - `rpc` is the typed ORPC proxy parameterized by the consumer's
//     `<TContract>`. The raw `RPCLink` is package-internal; it does NOT
//     appear on the public surface (CLAUDE.md "Public-surface review
//     checklist").
//
// Module-level singletons from the source app (`connectionStateManager`,
// `websocketHolder`, `linkFactory`, ...) become per-instance fields of
// the closure built here. CLAUDE.md "No god files" / "Dependency inversion".

import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract";
import type ReconnectingWebSocket from "partysocket/ws";
import {
  type Clock,
  type Logger,
  type Rng,
  noopLogger,
  systemClock,
  defaultRng,
} from "@repo/orpc-ws-shared";

// Logger seam + bridges re-exported so consumers stay on one import surface.
// `fromNestShape` deliberately omitted — Nest is a server-side concept; the
// nestjs adapter package re-exports it instead.
export type { Logger, PinoShape } from "@repo/orpc-ws-shared";
export {
  noopLogger,
  consoleLogger,
  fromPinoShape,
} from "@repo/orpc-ws-shared";

import { ConnectionStateManager } from "./state/connection-state.js";
import {
  connecting,
  disconnected,
  type ConnectionState,
} from "./state/types.js";
import { WebSocketHolder } from "./state/websocket-holder.js";

import { WebSocketFactory } from "./lifecycle/websocket-factory.js";
import { EventHandlers } from "./lifecycle/event-handlers.js";
import type {
  UrlProvider,
  WebSocketEventHandlers,
} from "./lifecycle/types.js";

import type { TokenProvider } from "./auth/token-provider.js";

import { TokenRefreshHandler } from "./reconnect/token-refresh-handler.js";
import { ReconnectManager } from "./reconnect/reconnect-manager.js";

import { LinkFactory } from "./client/link-factory.js";
import { createOrpcClientProxy } from "./client/orpc-client.js";

import { HeartbeatMonitor } from "./heartbeat/monitor.js";
import { HeartbeatSubscriber } from "./heartbeat/subscriber.js";

import { SleepDetector } from "./sleep/sleep-detector.js";

import {
  DEFAULT_RECONNECT_CONFIG,
  type ReconnectConfig,
} from "./config/reconnect-config.js";
import { createUrlBuilder } from "./config/url-builder.js";

import {
  OrpcHttpUploadStrategy,
  PresignedUrlUploadStrategy,
} from "./upload/orpc-http-strategy.js";
import type { UploadStrategy, Path } from "./upload/strategy.js";
import type {
  UploadOptions,
  UploadResult,
  UploadsConfig,
} from "./upload/types.js";

// ---------- Public types (re-exported for consumers) ----------

export type { ConnectionState } from "./state/types.js";
export { connecting, connected, disconnected, kicked } from "./state/types.js";
export type { TokenProvider } from "./auth/token-provider.js";
export type { OnTerminalAuthFailure } from "./auth/types.js";
export type { ReconnectConfig } from "./config/reconnect-config.js";
export { DEFAULT_RECONNECT_CONFIG } from "./config/reconnect-config.js";
export { createUrlBuilder } from "./config/url-builder.js";

export type {
  UploadsConfig,
  UploadOptions,
  UploadProgress,
  UploadResult,
} from "./upload/types.js";
export type { Path } from "./upload/strategy.js";

/**
 * Notifications worth reacting to imperatively (toast, redirect, log).
 *
 * NOT a state-transition channel — state transitions live on
 * `state.subscribe(cb)`. CLAUDE.md §"State vs events: separate concerns".
 */
export type ClientEvent =
  | {
      type: "auth_failure";
      /**
       * `true` when the library is going to attempt a refresh (the
       * EventHandlers close-decision routed to auth-recovery). `false`
       * when the library has given up (storm guard tripped or refresh
       * returned null) — pair with `onTerminalAuthFailure` for cleanup.
       */
      refreshable: boolean;
    }
  | { type: "heartbeat_timeout" }
  | { type: "woke_from_sleep"; sleepDurationMs: number };

/**
 * Options for `createOrpcWsClient`. All fields except `url` are optional;
 * defaults match the source app's existing behavior post-de-app-ification.
 */
export interface OrpcWsClientOptions {
  /**
   * WS base URL (e.g. `wss://api.example.com/ws`) or a thunk for dynamic
   * resolution (multi-region, runtime env switching). Token is appended as
   * `?token=` by the URL builder when a tokenProvider yields one;
   * otherwise the URL is used as-is (cookie-auth-ready).
   */
  url: string | (() => string);
  /**
   * Token producer. OPTIONAL — omit for cookie auth. When omitted, the
   * URL never carries a `?token=` param and any auth-recovery attempt
   * fires `onTerminalAuthFailure` immediately (the library can't refresh
   * without the seam). CLAUDE.md "Token transport".
   */
  tokenProvider?: TokenProvider;
  /**
   * Called when the library has given up on auth recovery PERMANENTLY:
   *   - `tokenProvider.refresh()` returned null, OR
   *   - the 30s storm-guard window tripped, OR
   *   - auth-recovery was attempted with no tokenProvider configured.
   *
   * Typical consumer wiring: redirect to /login, clear in-memory auth
   * state. The client is terminal after this fires; create a new one
   * post-re-auth to reconnect. CLAUDE.md §"Auth flow contract".
   */
  onTerminalAuthFailure?: () => void;
  /**
   * Notifications callback. Receives `ClientEvent` payloads — auth
   * failures, heartbeat timeouts, wake-from-sleep. Does NOT receive
   * state-transition notifications — those go through `state.subscribe`.
   */
  onEvent?: (evt: ClientEvent) => void;
  /**
   * Partial override of `DEFAULT_RECONNECT_CONFIG`. Merged shallowly,
   * so consumers can tune a single field (e.g. `{ debounceMs: 250 }`)
   * without restating the rest.
   */
  reconnect?: Partial<ReconnectConfig>;
  /**
   * Enable the Web-Worker sleep detector. Default `true`. Set `false`
   * to skip the worker (e.g. server-side rendering, non-browser
   * environments without `Worker`).
   */
  sleepDetection?: boolean;
  /** Pino-shape logger. Default: noop. */
  logger?: Logger;
  /** TEST hook — inject a fake clock. Production callers leave this. */
  clock?: Clock;
  /** TEST hook — inject a seeded RNG. Production callers leave this. */
  rng?: Rng;
  /**
   * Opt-in uploads transport. When configured, `client.upload(file, opts)`
   * is wired to the chosen strategy:
   *   - `orpc-http`: ships in v1. Uses ORPC's HTTP `RPCLink` with
   *     multipart over fetch.
   *   - `presigned-url`: reserved; throws "not implemented" at runtime.
   *
   * When omitted, `client.upload` is absent from the public API
   * (the property is optional in `OrpcWsClient`). CLAUDE.md "Uploads".
   */
  uploads?: UploadsConfig;
}

/**
 * The public client object returned by `createOrpcWsClient`.
 *
 * Surface is deliberately minimal: typed `rpc`, observable `state`, and
 * the `connect()` / `dispose()` lifecycle methods. No raw link, no
 * factory, no reconnect-manager pokes — every escape hatch the source
 * app exposed is now an internal collaborator. Anything a consumer
 * needs beyond this surface is a library bug, not a "reach into the
 * internals" use case.
 */
export interface OrpcWsClient<TContract extends AnyContractRouter> {
  /** Typed ORPC client proxy — `client.rpc.foo.bar({...})`. */
  rpc: ContractRouterClient<TContract>;
  /**
   * Reactive connection state. Same shape consumed by React's
   * `useSyncExternalStore`, Svelte stores, Vue's `customRef`, etc.
   * CLAUDE.md §"State contract".
   */
  state: {
    getState(): ConnectionState;
    subscribe(cb: () => void): () => void;
  };
  /**
   * Idempotent. Initiates the first WebSocket connection if not yet
   * connecting / connected. The library owns all subsequent reconnect
   * logic (storm guard, jitter, mutex, debounce). No-op in terminal
   * states (`kicked` from session-replaced; post-dispose).
   */
  connect(): void;
  /**
   * Terminal teardown. Closes the WS, stops all timers and watchers,
   * releases resources. After `dispose()` the client is dead; the
   * caller creates a new client to reconnect. CLAUDE.md §"Client
   * lifecycle API".
   */
  dispose(): void;
  /**
   * Upload a file via the HTTP transport. **Only present** when the
   * caller passed `uploads` to `createOrpcWsClient`. The property is
   * optional so consumers who didn't opt in don't see it at runtime
   * AND can't accidentally type-call it without a TS error.
   *
   * `procedure` is typed against `TContract` — renaming a procedure in
   * the contract surfaces as a compile error here, NOT a runtime
   * "procedure not found".
   *
   * For v1 the only shipping strategy is `orpc-http` (HTTP multipart
   * via ORPC's fetch link). `presigned-url` is reserved and throws
   * `Not implemented`. CLAUDE.md "Uploads".
   */
  upload?: (
    file: File | Blob,
    opts: {
      procedure: Path<TContract>;
      onProgress?: UploadOptions["onProgress"];
      signal?: UploadOptions["signal"];
      meta?: UploadOptions["meta"];
    },
  ) => Promise<UploadResult>;
}

// ---------- Factory ----------

/**
 * Internal: tokenProvider used when the consumer omits one. Returns
 * `null` for both `getToken()` and `refresh()`, which causes the URL
 * builder to skip `?token=` and any refresh attempt to immediately
 * fail-terminal. Cookie-auth path.
 *
 * Declared as a constant so the factory branches stay readable; the
 * absent-tokenProvider path is "fall back to this stub", not "scatter
 * `if (tokenProvider)` everywhere".
 */
const cookieAuthProvider: TokenProvider = {
  getToken: () => null,
  refresh: async () => null,
};

/**
 * Compose the orpc-ws client. Wires every internal class to its
 * collaborators and returns the public `OrpcWsClient` surface.
 *
 * @typeParam TContract  The consumer's contract router type. Carried
 *   end-to-end so `client.rpc.foo.bar({...})` is fully typed.
 */
export function createOrpcWsClient<TContract extends AnyContractRouter>(
  opts: OrpcWsClientOptions,
): OrpcWsClient<TContract> {
  // ----- 1. Resolve config / seams -----
  const logger: Logger = opts.logger ?? noopLogger;
  const clock: Clock = opts.clock ?? systemClock;
  const rng: Rng = opts.rng ?? defaultRng;
  const reconnectConfig: ReconnectConfig = {
    ...DEFAULT_RECONNECT_CONFIG,
    ...opts.reconnect,
  };
  const urlBuilder = createUrlBuilder(opts.url);
  const tokenProvider: TokenProvider =
    opts.tokenProvider ?? cookieAuthProvider;
  const hasTokenProvider = opts.tokenProvider !== undefined;
  const onEvent = opts.onEvent;

  // Notification emitter wrapper: swallows consumer errors so a bad
  // callback can't break library invariants. Same pattern the state
  // manager uses for subscriber callbacks.
  const emit = (evt: ClientEvent): void => {
    if (!onEvent) return;
    try {
      onEvent(evt);
    } catch (err) {
      logger.error("orpc-ws-client: onEvent callback threw", {
        type: evt.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // ----- 2. State + holder -----
  // Initial state is `disconnected({willRetry: false})` — the client
  // hasn't been asked to connect yet. `connect()` moves us to
  // `connecting`. Picking `disconnected` (not `connecting`) at construction
  // time matters: a consumer subscribing before `connect()` should not see
  // a spurious "connecting" frame.
  const connectionState = new ConnectionStateManager(
    disconnected({ willRetry: false }),
    { logger },
  );
  const websocketHolder = new WebSocketHolder();

  // ----- 3. Heartbeat (built before LinkFactory consumes it via subscriber) -----
  const heartbeatMonitor = new HeartbeatMonitor({ clock, logger });

  // ----- 4. Link factory + typed proxy -----
  // `getWebSocket` is a closure over the holder — the link factory
  // resolves the CURRENT wrapper on first `getLink()` (lazy), and
  // any subsequent `clearLink()` + `getLink()` picks up whatever
  // partysocket wrapper the holder currently owns.
  const linkFactory = new LinkFactory(() => websocketHolder.get(), logger);
  const rpc = createOrpcClientProxy<TContract>(linkFactory);

  // ----- 5. Heartbeat subscriber (needs the link factory) -----
  const heartbeatSubscriber = new HeartbeatSubscriber({
    linkFactory,
    monitor: heartbeatMonitor,
    logger,
  });

  // ----- 6. WebSocket factory -----
  const websocketFactory = new WebSocketFactory({ logger });

  // ----- 6b. Terminal-auth-failure path + dispose flag -----
  // `disposed` is declared here (not next to `dispose()` in step 12)
  // because the TokenRefreshHandler's `isDisposed` predicate below closes
  // over it — the declaration must precede the wiring.
  let disposed = false;

  // Single-fire terminal teardown (Bug 14). The public contract
  // (`onTerminalAuthFailure` docs above) says the client is TERMINAL after
  // this fires — previously nothing made that true: the partysocket
  // wrapper kept auto-retrying with the stale token, every rejected retry
  // re-fired the consumer callback, and state stayed
  // `disconnected({willRetry: true})` forever.
  //
  // Both terminal triggers route here: the ReconnectManager (refresh
  // returned null / storm guard tripped — it has its own internal
  // single-fire latch) and the no-tokenProvider auth-recovery branch in
  // step 8. This closure carries the composition-level latch so the two
  // paths together fire the consumer callback at most once per client.
  //
  // Teardown mirrors `dispose()`'s ordering: close the wrapper FIRST
  // (partysocket's `close()` latches its internal `_closeCalled` flag and
  // stops the auto-retry loop — same technique as the 4005 branch in
  // event-handlers.ts), then clear the holder/link so the wrapper's late
  // close event is stale-dropped (Bug 9 guard) instead of fighting the
  // terminal state we set below.
  let terminalAuthFired = false;
  const fireTerminalAuthFailure = (): void => {
    if (terminalAuthFired) {
      logger.debug(
        "orpc-ws-client: terminal auth failure already handled; ignoring repeat",
      );
      return;
    }
    terminalAuthFired = true;

    heartbeatSubscriber.unsubscribe();
    heartbeatMonitor.stop();

    const ws = websocketHolder.get();
    if (ws) {
      try {
        ws.close();
      } catch (err) {
        logger.warn(
          "orpc-ws-client: ws.close() during terminal auth failure threw",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }
    linkFactory.clearLink();
    websocketHolder.clear();

    // Terminal state BEFORE the consumer callback — the contract in
    // auth/types.ts promises the connection has already moved to a
    // non-retrying disconnected state when the callback runs.
    connectionState.setState(disconnected({ willRetry: false }));

    emit({ type: "auth_failure", refreshable: false });
    if (opts.onTerminalAuthFailure) {
      try {
        opts.onTerminalAuthFailure();
      } catch (err) {
        logger.error("orpc-ws-client: onTerminalAuthFailure callback threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  // ----- 7. Token refresh + reconnect manager (with forward-ref dance) -----
  // EventHandlers needs `onAuthRecoveryNeeded` wired to
  // `reconnectManager.tryAuthRecovery`, BUT ReconnectManager construction
  // needs TokenRefreshHandler, BUT TokenRefreshHandler.getEventHandlers
  // needs EventHandlers. The source app's solution (let-assignment after
  // the fact) is preserved verbatim — minimum-edit principle for the
  // load-bearing wiring.
  let eventHandlers: EventHandlers | null = null;
  // Synthesize a per-call handler triple. EventHandlers.createHandlers
  // declares a `_wrapper` parameter purely for parallel-position with the
  // factory call site — the wrapper is closure-bound INSIDE the factory
  // (see websocket-factory.ts), so the value we pass here never reaches
  // an `onClose` callback. The wrapper-equality check (Bug 9) uses the
  // holder's CURRENT wrapper at close time, not the value passed here.
  // We construct a minimal placeholder that satisfies the structural type
  // — never observable, never invoked.
  const createFreshHandlers = (): WebSocketEventHandlers => {
    if (!eventHandlers) {
      throw new Error(
        "[orpc-ws-client] internal: eventHandlers used before composition completed",
      );
    }
    // The parameter is structurally `ReconnectingWebSocket` but never
    // dereferenced. An empty object cast satisfies the type without
    // requiring us to construct a real wrapper here.
    return eventHandlers.createHandlers(
      {} as unknown as ReconnectingWebSocket,
    );
  };

  // The TokenRefreshHandler's getEventHandlers() is parameterless: every
  // call yields a fresh handler triple for the next wrapper.
  const tokenRefreshHandler = new TokenRefreshHandler({
    tokenProvider,
    websocketHolder,
    websocketFactory,
    urlBuilder,
    getEventHandlers: () => createFreshHandlers(),
    reconnectConfig,
    heartbeatMonitor,
    heartbeatSubscriber,
    linkClearer: () => linkFactory.clearLink(),
    // Refuse the socket swap after the client is dead — either disposed
    // (Bug 12) OR terminal (Bug 14). The terminal guard closes a race the
    // shared storm window (Bug 16/BUG-5) makes reachable: a reconnect()
    // refresh can still be in flight when a concurrent 1008 trips
    // `tryAuthRecovery` into terminal teardown; without this, the resolving
    // refresh would `swapSocket` a brand-new socket AFTER terminal and flip
    // state back to `connected` (zombie-after-terminal).
    isDisposed: () => disposed || terminalAuthFired,
    logger,
  });

  const reconnectManager = new ReconnectManager({
    tokenRefreshHandler,
    reconnectConfig,
    // Library has given up (refresh returned null / storm guard tripped).
    // Route to the single-fire terminal teardown above — close the
    // wrapper, set terminal state, notify the consumer once.
    onTerminalAuthFailure: fireTerminalAuthFailure,
    // Cookie auth (no tokenProvider): the stub provider's `refresh()`
    // always returns null, which must NOT read as "auth is dead" on the
    // `reconnect()` path (sleep-wake / heartbeat timeout) — see
    // `ReconnectManagerDeps.canRefresh`.
    canRefresh: hasTokenProvider,
    clock,
    rng,
    logger,
  });

  // ----- 8. Event handlers (consumes reconnectManager via callbacks) -----
  eventHandlers = new EventHandlers({
    connectionState,
    websocketHolder,
    onAuthRecoveryNeeded: (closeCode) => {
      // If the consumer didn't supply a tokenProvider, we cannot refresh.
      // Skip the storm-guard path; go straight to terminal so the
      // consumer's app-level cleanup runs and we don't hand the no-op
      // provider a `refresh()` call that would loop on null.
      if (!hasTokenProvider) {
        logger.warn(
          "orpc-ws-client: auth-recovery needed but no tokenProvider configured; firing terminal",
          { closeCode },
        );
        // Same single-fire terminal path as the ReconnectManager triggers
        // (Bug 14) — tears down the wrapper and fires the consumer
        // callback at most once per client.
        fireTerminalAuthFailure();
        return;
      }
      // We DO have a tokenProvider — the library is going to try a
      // refresh. Emit `refreshable: true` so the consumer can surface a
      // brief "reconnecting" toast without redirecting yet.
      emit({ type: "auth_failure", refreshable: true });
      void reconnectManager.tryAuthRecovery(closeCode);
    },
    logger,
    onOpen: () => {
      // Per-open setup: start the heartbeat subscriber so it begins
      // consuming the stealth `__orpc_ws_lib__.heartbeat` procedure now
      // that the link can be built against the open WS. `subscribe()` is
      // idempotent w.r.t. prior aborted loops (Phase 1.5) — if a previous
      // attempt left a draining loop around, the call awaits its teardown
      // and starts fresh.
      void heartbeatSubscriber.subscribe();
    },
    onClose: () => {
      // Per-close teardown: stop the heartbeat watchdog and subscriber.
      // The next successful open will re-subscribe via the onOpen hook
      // above (subscribe() is idempotent w.r.t. prior aborted loops; see
      // Phase 1.5 docs).
      heartbeatSubscriber.unsubscribe();
      heartbeatMonitor.stop();
    },
  });

  // ----- 9. Heartbeat timeout → reconnect -----
  heartbeatMonitor.onTimeout(() => {
    // Don't reconnect if terminal (kicked). The reconnect manager would
    // happily process the call but the user's session is gone.
    const s = connectionState.getState();
    if (s.status === "kicked") {
      logger.info(
        "orpc-ws-client: heartbeat timeout in kicked state — ignoring",
      );
      return;
    }
    emit({ type: "heartbeat_timeout" });
    // Bug 15: a heartbeat timeout means the link is dead even though no
    // close event arrived (half-open zombie — the close may NEVER come).
    // Without this transition the UI keeps showing `connected` over a
    // dead socket; if the subsequent recovery's refresh also fails, it
    // would show `connected` forever. Guarded on `connected` so we never
    // fight the close-event state path (which owns `disconnected({code,
    // ...})` transitions) or clobber a `connecting` frame from a racing
    // swap. Re-read AFTER emit — a consumer's onEvent may have disposed
    // the client, and we must not overwrite its terminal state.
    if (connectionState.getState().status === "connected") {
      connectionState.setState(disconnected({ willRetry: true }));
    }
    void reconnectManager.reconnect();
  });

  // ----- 10. Sleep detector (optional) -----
  const sleepDetectionEnabled = opts.sleepDetection !== false;
  let sleepDetector: SleepDetector | null = null;
  if (sleepDetectionEnabled) {
    sleepDetector = new SleepDetector({
      onWake: (sleepDurationMs) => {
        emit({ type: "woke_from_sleep", sleepDurationMs });
        // V1: just trigger a reconnect. The source app's `public-api.ts`
        // first attempted a `system.ping` health check, but that path
        // depends on the consumer's contract carrying a ping procedure —
        // out of scope for v1. The library's reconnect manager already
        // handles the "already connected" path safely.
        const s = connectionState.getState();
        if (s.status === "kicked") return;
        void reconnectManager.reconnect();
      },
      clock,
      logger,
    });
  }

  // ----- 11. The URL provider closure -----
  // partysocket re-invokes this on EVERY internal reconnect attempt, so
  // a token swap during sleep is picked up automatically (Bug 1 fix).
  const urlProvider: UrlProvider = () => {
    const token = tokenProvider.getToken();
    websocketHolder.setCurrentToken(token);
    return urlBuilder(token);
  };

  // ----- 12. Lifecycle: connect() / dispose() -----
  // (`disposed` is declared in step 6b — the TokenRefreshHandler's
  // `isDisposed` predicate closes over it.)
  const connect = (): void => {
    if (disposed) {
      logger.warn("orpc-ws-client: connect() called after dispose(); ignoring");
      return;
    }
    if (terminalAuthFired) {
      // Terminal auth failure is a one-way door (Bug 14): the state is
      // `disconnected({willRetry: false})`, which is also the
      // pre-first-connect state, so the latch — not the state — is what
      // distinguishes "never connected" from "library gave up". Per the
      // contract the consumer creates a NEW client post-re-auth.
      logger.warn(
        "orpc-ws-client: connect() after terminal auth failure; ignoring — create a new client",
      );
      return;
    }
    const s = connectionState.getState();
    // Idempotency / terminal-state guards.
    if (
      s.status === "connecting" ||
      s.status === "connected" ||
      s.status === "kicked"
    ) {
      return;
    }
    // Bug 13: the status guard above misses the auto-retry window. After
    // any drop the state is `disconnected({willRetry: true})` while the
    // EXISTING partysocket wrapper is still retrying internally (default
    // maxRetries: Infinity). Creating a second wrapper here would
    // overwrite the holder reference and orphan the old wrapper — never
    // closed, reconnecting forever; with the server's
    // singleConnectionPerUser the two perpetually 4005-kick each other.
    // A wrapper in the holder means the library already owns reconnect;
    // the idempotent behavior is to leave it alone. (The dispose and
    // terminal-auth teardowns both clear the holder, so those paths never
    // reach this guard — their latches above return first anyway.)
    if (websocketHolder.get() !== null) {
      logger.debug(
        "orpc-ws-client: connect() ignored — a connection already exists; the library owns reconnect",
      );
      return;
    }
    // Move to connecting BEFORE creating the WS so the very first
    // subscriber tick reflects the right state.
    connectionState.setState(connecting());

    const ws = websocketFactory.create(
      urlProvider,
      createFreshHandlers(),
      reconnectConfig,
    );
    websocketHolder.set(ws);

    if (sleepDetector && !sleepDetector.isRunning()) {
      sleepDetector.start();
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    // Stop background work first so a tick mid-teardown can't reach a
    // half-disposed collaborator. The reconnect manager goes down with
    // them (Bug 12): an armed debounce timer or in-flight refresh would
    // otherwise fire AFTER this teardown and resurrect a zombie socket.
    reconnectManager.dispose();
    heartbeatSubscriber.unsubscribe();
    heartbeatMonitor.stop();
    if (sleepDetector) sleepDetector.stop();

    // Close the underlying socket (if any) and clear caches.
    const ws = websocketHolder.get();
    if (ws) {
      try {
        ws.close();
      } catch (err) {
        // Best-effort: a partysocket already in a bad state may throw.
        logger.warn("orpc-ws-client: ws.close() during dispose threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    linkFactory.clearLink();
    websocketHolder.clear();

    // Terminal state. `willRetry: false` distinguishes this from
    // partysocket's auto-retry path (which would be willRetry: true).
    connectionState.setState(disconnected({ willRetry: false }));
  };

  // ----- 13. Upload strategy (optional) -----
  // Instantiate eagerly when `uploads` is configured so any
  // strategy-construction error (e.g. presigned-url throws on use, but
  // a future variant could throw at construct time too) surfaces during
  // `createOrpcWsClient`, not on first call.
  let uploadStrategy: UploadStrategy | null = null;
  if (opts.uploads) {
    if (opts.uploads.strategy === "orpc-http") {
      uploadStrategy = new OrpcHttpUploadStrategy({
        httpUrl: opts.uploads.httpUrl,
        // The composition root holds the *real* tokenProvider — not the
        // `cookieAuthProvider` stub. Cookie-auth consumers (no
        // tokenProvider configured) get no Authorization header, same
        // shape as the WS URL builder when no token is available.
        tokenProvider: opts.tokenProvider,
        logger,
      });
    } else {
      // strategy === "presigned-url". The class throws on `upload()`;
      // construction is cheap (no network) so we instantiate eagerly.
      uploadStrategy = new PresignedUrlUploadStrategy();
    }
  }

  // Public upload method — present only when a strategy was wired.
  // Spread into the return object conditionally so consumers without
  // uploads don't see the property at runtime (Object.keys works as
  // expected, JSON.stringify doesn't include it, etc.).
  const upload = uploadStrategy
    ? (
        file: File | Blob,
        publicOpts: {
          procedure: Path<TContract>;
          onProgress?: UploadOptions["onProgress"];
          signal?: UploadOptions["signal"];
          meta?: UploadOptions["meta"];
        },
      ): Promise<UploadResult> => {
        // `Path<TContract>` is structurally a string tuple; the strategy
        // interface takes a plain `string[]`. Spread is type-safe — the
        // `Path` tuple narrows to a readonly array of strings.
        const procedure = [...(publicOpts.procedure as readonly string[])];
        const internalOpts: UploadOptions = {
          procedure,
          ...(publicOpts.onProgress
            ? { onProgress: publicOpts.onProgress }
            : {}),
          ...(publicOpts.signal ? { signal: publicOpts.signal } : {}),
          ...(publicOpts.meta ? { meta: publicOpts.meta } : {}),
        };
        // Non-null assertion is safe — we're inside the
        // `uploadStrategy ?` branch.
        return uploadStrategy!.upload(file, internalOpts);
      }
    : undefined;

  const client: OrpcWsClient<TContract> = {
    rpc,
    state: {
      getState: () => connectionState.getState(),
      subscribe: (cb) => connectionState.subscribe(cb),
    },
    connect,
    dispose,
  };
  if (upload) {
    client.upload = upload;
  }
  return client;
}
