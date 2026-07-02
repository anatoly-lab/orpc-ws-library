// Public surface of @orpc-ws/client — the composition root.
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
import type { AnyRouter, InferRouterInitialContext } from "@orpc/server";
import type ReconnectingWebSocket from "partysocket/ws";
import {
  type Clock,
  type Logger,
  type Rng,
  noopLogger,
  systemClock,
  defaultRng,
} from "@orpc-ws/shared";

// Logger seam + bridges re-exported so consumers stay on one import surface.
// `fromNestShape` deliberately omitted — Nest is a server-side concept; the
// nestjs adapter package re-exports it instead.
export type { Logger, PinoShape } from "@orpc-ws/shared";
export {
  noopLogger,
  consoleLogger,
  fromPinoShape,
} from "@orpc-ws/shared";

import { ConnectionStateManager } from "./state/connection-state.js";
import { disconnected, type ConnectionState } from "./state/types.js";
import { WebSocketHolder } from "./state/websocket-holder.js";

import { WebSocketFactory } from "./lifecycle/websocket-factory.js";
import { EventHandlers } from "./lifecycle/event-handlers.js";
import { ClientLifecycle } from "./lifecycle/client-lifecycle.js";
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

import { type ClientBidi, createClientBidi } from "./bidi/client-bidi.js";
import { BidiWebSocketFactory } from "./bidi/bidi-websocket-factory.js";

import {
  type ReconnectConfig,
  resolveReconnectConfig,
} from "./config/reconnect-config.js";
import { createUrlBuilder } from "./config/url-builder.js";

import {
  OrpcHttpUploadStrategy,
  PresignedUrlUploadStrategy,
} from "./upload/orpc-http-strategy.js";
import type { UploadStrategy, Path } from "./upload/strategy.js";
import { createUploadMethod } from "./upload/upload-method.js";
import type {
  UploadOptions,
  UploadResult,
  UploadsConfig,
} from "./upload/types.js";

import type { ClientEvent } from "./events.js";

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
export type { ClientEvent } from "./events.js";

// Typed "socket not OPEN yet" error from the link factory — PUBLIC so
// adapters/consumers can classify the establishment race (a drop landing
// between a `connected` observation and the actual RPC) as transient
// instead of a real failure. `@orpc-ws/react`'s `useWsSubscription`
// suppresses it by `name`, like an AbortError.
export { LinkNotReadyError } from "./client/link-factory.js";

// Stable delegating server→client router primitive (issue #7 Phase 1). PUBLIC
// so the `@orpc-ws/react` adapter's `<OrpcWs>` (Phase 2) can build one identity-
// stable `clientRouter` whose leaves delegate to per-render handlers via a ref.
export {
  createDelegatingClientRouter,
  type DelegatingHandler,
} from "./bidi/delegating-router.js";

/**
 * Base options for `createOrpcWsClient`, common to bidi-on and bidi-off. The
 * public {@link OrpcWsClientOptions} alias adds the server→client (bidi) fields
 * on top, conditionally typed against the client router.
 *
 * All fields except `url` are optional; defaults match the source app's existing
 * behavior post-de-app-ification.
 */
interface BaseOrpcWsClientOptions {
  /**
   * WS base URL (e.g. `wss://api.example.com/ws`) or a thunk for dynamic
   * resolution (multi-region, runtime env switching). Token is appended as
   * `?token=` by the URL builder when a tokenProvider yields one;
   * otherwise the URL is used as-is (cookie-auth-ready).
   */
  url: string | (() => string);
  /**
   * Token producer. OPTIONAL — omit for cookie auth. When omitted, the
   * URL never carries a `?token=` param, and only a REAL auth-failure
   * close (1008 / 4001) fires `onTerminalAuthFailure` — a synthetic
   * pre-open close-1000 (network failure masked by the browser) is a
   * benign no-op that rides partysocket's retry loop (Bug 24; CLAUDE.md
   * §"Auth flow contract", "Cookie-auth caveat"). CLAUDE.md "Token
   * transport".
   *
   * COROLLARY for cookie-mode consumers: a session that dies while the
   * client is disconnected is INVISIBLE here. The server rejects the dead
   * `sid` at the HTTP upgrade, the WebSocket spec masks the rejection
   * reason from the browser, and partysocket surfaces it as the same
   * synthetic pre-open close-1000 as a down server or a network blip — so
   * the client retries silently forever and neither
   * `onTerminalAuthFailure` nor `onEvent` fires. Detect session death at
   * the APPLICATION level instead: e.g. `/auth/me` returning 401, or — for
   * a session revoked mid-connection — the server closing with 1008/4001
   * (`closeUser` / token expiry), which DOES reach this client as a real
   * auth-failure close.
   */
  tokenProvider?: TokenProvider;
  /**
   * Called when the library has given up on auth recovery PERMANENTLY:
   *   - `tokenProvider.refresh()` returned null, OR
   *   - the 30s storm-guard window tripped, OR
   *   - a server-signalled auth close (1008 / 4001) arrived with no
   *     tokenProvider configured (cookie auth — nothing to refresh).
   *
   * Typical consumer wiring: redirect to /login, clear in-memory auth
   * state. The client is terminal after this fires; create a new one
   * post-re-auth to reconnect. CLAUDE.md §"Auth flow contract".
   *
   * Cookie-mode note: a session that dies while the client is
   * DISCONNECTED never reaches this callback — the handshake-time
   * rejection is masked by the WebSocket spec (see the corollary on
   * `tokenProvider` above); rely on an application-level signal such as
   * `/auth/me` returning 401.
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
 * The server→client ("bidi") arm of {@link OrpcWsClientOptions}, conditionally
 * typed against the client router so `clientContext` is REQUIRED exactly when the
 * router needs an initial context — REUSING the Phase-4 host's rule
 * ({@link ClientRouterHostOptions} / `createClientRouterHost`).
 *
 * Three arms, selected by `TClientRouter`:
 *   - bidi OFF (`never`, the default when `TClientRouter` is left unspecified):
 *     neither field may be set — keeps the off path byte-identical and honest.
 *   - bidi ON, router needs NO context: `clientRouter` is required, `clientContext`
 *     optional.
 *   - bidi ON, router REQUIRES a context: BOTH `clientRouter` and `clientContext`
 *     are mandatory (omitting `clientContext` — or passing `{}` for a non-empty
 *     context — is a compile error).
 *
 * `clientRouter` is REQUIRED on both bidi-on arms (not just present): because
 * `TClientRouter` cannot be inferred (see {@link OrpcWsClientOptions} — it must be
 * passed explicitly as `typeof clientRouter`), making `clientRouter` required is
 * what closes the desync hole — specifying the generic but omitting the value is a
 * compile error, so the type can never claim bidi-on while the runtime switch
 * (`clientRouter !== undefined`) is off.
 */
type BidiClientArm<TClientRouter extends AnyRouter> = [TClientRouter] extends [
  never,
]
  ? { clientRouter?: never; clientContext?: never }
  : Record<never, never> extends InferRouterInitialContext<TClientRouter>
    ? {
        clientRouter: TClientRouter;
        clientContext?: InferRouterInitialContext<TClientRouter>;
      }
    : {
        clientRouter: TClientRouter;
        clientContext: InferRouterInitialContext<TClientRouter>;
      };

/**
 * Options for `createOrpcWsClient`.
 *
 * @typeParam TClientRouter  The CLIENT's OWN router (server→client / "bidi") —
 *   the procedures the client answers when the server calls it. To enable bidi
 *   you MUST specify it EXPLICITLY as `typeof clientRouter` alongside the
 *   contract:
 *
 *   ```ts
 *   createOrpcWsClient<MyContract, typeof clientRouter>({ url, clientRouter });
 *   ```
 *
 *   It cannot be inferred: `TContract` appears only in the return type and so
 *   must always be given explicitly, and TypeScript does NOT support partial
 *   type-argument inference — once any type argument is supplied, an omitted
 *   defaulted one (`TClientRouter`) falls to its default (`never`) rather than
 *   being inferred from `clientRouter`. To prevent the resulting desync,
 *   `clientRouter` is REQUIRED (not just allowed) on both bidi-on arms of
 *   {@link BidiClientArm}: passing the generic but omitting the value is a
 *   compile error.
 *
 *   Omit the generic entirely (the default `never`) and the client is
 *   byte-identical to a non-bidi client — no multiplexer, raw wrapper to the
 *   link, heartbeat untouched; `clientRouter`/`clientContext` are then forbidden.
 */
export type OrpcWsClientOptions<TClientRouter extends AnyRouter = never> =
  BaseOrpcWsClientOptions & BidiClientArm<TClientRouter>;

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
export function createOrpcWsClient<
  TContract extends AnyContractRouter,
  TClientRouter extends AnyRouter = never,
>(opts: OrpcWsClientOptions<TClientRouter>): OrpcWsClient<TContract> {
  // ----- 1. Resolve config / seams -----
  const logger: Logger = opts.logger ?? noopLogger;
  const clock: Clock = opts.clock ?? systemClock;
  const rng: Rng = opts.rng ?? defaultRng;
  // Merge + enforce the reconnect contract: a finite `maxRetries` is
  // unsupported (S1) — `resolveReconnectConfig` warns and forces it back to
  // Infinity so partysocket never silently exhausts its retry loop and wedges
  // `connect()`.
  const reconnectConfig = resolveReconnectConfig(opts.reconnect, logger);
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

  // ----- 2b. Bidi coordinator (server→client RPC) — opt-in, OFF = byte-identical -----
  // Presence of `clientRouter` is the bidi switch. When ON, the c2s RPCLink (and
  // therefore the stealth heartbeat that rides it) binds the c2s `ChanneledSocket`
  // facade instead of the raw wrapper, and the consumer's router is hosted on the
  // s2c channel — see bidi/client-bidi.ts. When OFF (`null`), the LinkFactory
  // below binds the RAW wrapper, no multiplexer is interposed, and the heartbeat
  // path is untouched: identical to the pre-bidi client.
  //
  // The conditional-rest context CONTRACT was enforced at THIS factory's call
  // site (OrpcWsClientOptions, against the concrete TClientRouter). Inside the
  // body TClientRouter is generic, so — like the Phase-4 host's own internal
  // widening — we forward a plain `{ context }` (the coordinator/host default a
  // missing context to `{}`).
  const bidi: ClientBidi | null =
    opts.clientRouter !== undefined
      ? createClientBidi(opts.clientRouter, logger, {
          context: opts.clientContext,
        })
      : null;

  // ----- 3. Heartbeat (built before LinkFactory consumes it via subscriber) -----
  const heartbeatMonitor = new HeartbeatMonitor({ clock, logger });

  // ----- 4. Link factory + typed proxy -----
  // `getWebSocket` is a closure resolving the CURRENT socket the c2s RPCLink
  // binds to, lazily on the first `getLink()`; a `clearLink()` + `getLink()`
  // picks up whatever that closure now yields.
  //   - bidi OFF: the raw partysocket wrapper from the holder (pre-bidi behavior).
  //   - bidi ON: the c2s `ChanneledSocket` facade of the CURRENT mux — so on a
  //     wrapper swap the rebuilt mux's new facade is picked up on the next link
  //     rebuild, exactly as the holder's wrapper would have been.
  const linkFactory = new LinkFactory(
    bidi ? () => bidi.c2sLinkSocket() : () => websocketHolder.get(),
    logger,
  );
  const rpc = createOrpcClientProxy<TContract>(linkFactory);

  // ----- 5. Heartbeat subscriber (needs the link factory) -----
  const heartbeatSubscriber = new HeartbeatSubscriber({
    linkFactory,
    monitor: heartbeatMonitor,
    logger,
    // The pre-config retry timer (NFI-1) goes through the Clock seam so
    // composition-level tests stay deterministic.
    clock,
    // Option B: the subscriber has no socket-state knowledge. The
    // open-vs-closed teardown decision (`abort()` vs `drop()`) lives in
    // the lifecycle orchestrator, which already owns teardown sequencing.
    // See HeartbeatSubscriber.abort()/drop() for the orpc abort-send race.
  });

  // ----- 6. WebSocket factory -----
  // When bidi is ON, every NEW wrapper (the first `connect()` AND every
  // `swapSocket()` reconnect both route through `WebSocketFactory.create`) must
  // (re)build the bidi mux + s2c host against it and retire the previous one.
  // `create` is the single chokepoint where a wrapper is born, so a subclass that
  // calls `bidi.attach(ws)` right after construction is the one place to hook it —
  // ClientLifecycle and TokenRefreshHandler stay untouched (they only see a
  // `WebSocketFactory`). On a swap the OLD wrapper was already closed before this
  // `create` runs (its close fan-out aborted in-flight s2c executions), so
  // `attach`'s dispose-previous honors close-before-dispose. When OFF, the plain
  // factory is used — byte-identical.
  const websocketFactory: WebSocketFactory = bidi
    ? new BidiWebSocketFactory({ logger }, bidi)
    : new WebSocketFactory({ logger });

  // ----- 6b. URL provider + lifecycle controller -----
  // Declared here, ASSIGNED in step 10 — the lifecycle controller reads it
  // through the lazy `getSleepDetector` thunk below, so the binding must
  // exist before the controller is constructed.
  let sleepDetector: SleepDetector | null = null;

  // The URL provider closure. partysocket re-invokes this on EVERY internal
  // reconnect attempt, so a token swap during sleep is picked up
  // automatically (Bug 1 fix).
  const urlProvider: UrlProvider = () => {
    const token = tokenProvider.getToken();
    websocketHolder.setCurrentToken(token);
    return urlBuilder(token);
  };

  // Lifecycle + terminal-state controller: `connect()` / `dispose()`, the
  // single-fire terminal-auth teardown, the kicked teardown, and the unified
  // `isDead` predicate (see lifecycle/client-lifecycle.ts for the full
  // rationale on each). `createFreshHandlers`, `sleepDetector` and
  // `reconnectManager` are declared AFTER this construction but only
  // referenced inside thunks invoked post-composition, so the forward
  // references are safe — the closures capture the bindings, they aren't
  // called here. (The explicit `: ClientLifecycle` annotation breaks the
  // type-inference cycle lifecycle → getReconnectManager → reconnectManager
  // → isDead — TS7022 otherwise.)
  const lifecycle: ClientLifecycle = new ClientLifecycle({
    connectionState,
    websocketHolder,
    linkFactory,
    heartbeatMonitor,
    heartbeatSubscriber,
    websocketFactory,
    reconnectConfig,
    urlProvider,
    createHandlers: () => createFreshHandlers(),
    getSleepDetector: () => sleepDetector,
    getReconnectManager: () => reconnectManager,
    emit,
    onTerminalAuthFailure: opts.onTerminalAuthFailure,
    // Retire the bidi mux + s2c host on EVERY death path — dispose(),
    // terminal auth failure, kicked (4005) — not just dispose(). Each of
    // those paths has already closed the wrapper (its synchronous close
    // fan-out settles in-flight bidi calls) before the lifecycle invokes
    // this, honoring close-before-dispose; `bidi.dispose` is idempotent
    // (flag-guarded in bidi/client-bidi.ts `makeBidiDispose`, and
    // `disposeCurrent` nulls its handle), so a later `client.dispose()`
    // re-running it is safe.
    ...(bidi ? { disposeBidi: bidi.dispose } : {}),
    logger,
  });

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
    // State truthfulness at swap start: the Bug-21 clear-before-close fix
    // stale-drops the old wrapper's own close, so a swap tearing down an
    // OPENED wrapper (sleep-wake / upload-401 while `connected`) must set
    // `disconnected({willRetry: true})` itself — Bug 15 parity; see
    // `TokenRefreshHandlerDeps.connectionState`.
    connectionState,
    // Refuse the socket swap after the client is dead — disposed (Bug 12),
    // terminal (Bug 14), OR kicked (F1). The guard closes a race the
    // shared storm window (Bug 16/BUG-5) makes reachable: a reconnect()
    // refresh can still be in flight when a concurrent 1008 trips
    // `tryAuthRecovery` into terminal teardown — or a concurrent 4005
    // kicks the session; without this, the resolving refresh would
    // `swapSocket` a brand-new socket AFTER the death and flip state back
    // to `connected` (zombie-after-terminal / kicked resurrection).
    isDead: lifecycle.isDead,
    logger,
  });

  const reconnectManager = new ReconnectManager({
    tokenRefreshHandler,
    reconnectConfig,
    // Library has given up (refresh returned null / storm guard tripped).
    // Route to the single-fire terminal teardown above — close the
    // wrapper, set terminal state, notify the consumer once.
    onTerminalAuthFailure: lifecycle.fireTerminalAuthFailure,
    // Cookie auth (no tokenProvider): the stub provider's `refresh()`
    // always returns null, which must NOT read as "auth is dead" on the
    // `reconnect()` path (sleep-wake / heartbeat timeout) — see
    // `ReconnectManagerDeps.canRefresh`.
    canRefresh: hasTokenProvider,
    // Short-circuit ALL reconnect machinery at the entry points once the
    // client is dead (F1/F3) — covering the deaths the manager's own
    // latches don't know about: the `kicked` state (session replaced) and
    // the no-tokenProvider terminal path, which fires
    // `fireTerminalAuthFailure` directly without routing through this
    // manager.
    isDead: lifecycle.isDead,
    clock,
    rng,
    logger,
  });

  // ----- 8. Event handlers (consumes reconnectManager via callbacks) -----
  eventHandlers = new EventHandlers({
    connectionState,
    websocketHolder,
    onAuthRecoveryNeeded: (closeCode, trigger) => {
      // If the consumer didn't supply a tokenProvider, we cannot refresh.
      if (!hasTokenProvider) {
        // Cookie-auth caveat (CLAUDE.md §"Auth flow contract"; Bug 24):
        // with no tokenProvider, only a REAL auth-failure close (1008 /
        // 4001) may go terminal. A pre-open code-1000 close is
        // partysocket's synthetic shape for EVERY pre-open failure —
        // connection refused, DNS, TLS (the browser masks the real
        // reason) — so under cookie auth it is a benign no-op: partysocket
        // keeps retrying on its own backoff, and the session cookie needs
        // no refresh from us. Pre-fix this branch went terminal here,
        // force-logging-out a healthy cookie client on any transient
        // pre-open network blip.
        if (trigger === "pre-open-1000") {
          logger.debug(
            "orpc-ws-client: pre-open close-1000 with no tokenProvider — benign; riding partysocket's retry loop",
            { closeCode },
          );
          return;
        }
        // A server-signalled auth close with nothing to refresh: skip the
        // storm-guard path; go straight to terminal so the consumer's
        // app-level cleanup runs and we don't hand the no-op provider a
        // `refresh()` call that would loop on null.
        logger.warn(
          "orpc-ws-client: auth-recovery needed but no tokenProvider configured; firing terminal",
          { closeCode },
        );
        // Same single-fire terminal path as the ReconnectManager triggers
        // (Bug 14) — tears down the wrapper and fires the consumer
        // callback at most once per client.
        lifecycle.fireTerminalAuthFailure();
        return;
      }
      // We DO have a tokenProvider — the library is going to try a
      // refresh. Emit `refreshable: true` so the consumer can surface a
      // brief "reconnecting" toast without redirecting yet.
      emit({ type: "auth_failure", refreshable: true });
      // Forward the trigger provenance (Bug 24 discriminant) into the
      // storm guard too (Bug 25): a storm trip stays terminal for a real
      // auth close (1008/4001) but downgrades to
      // reconnect-with-current-token for the ambiguous pre-open 1000 —
      // a server that is merely DOWN must not force a logout within ~30s.
      void reconnectManager.tryAuthRecovery(closeCode, trigger);
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
      // This hook runs FROM the socket's `close` event (partysocket 1.3.0
      // dispatches it synchronously from `close()`), so the socket is
      // already CLOSED/CLOSING — use `drop()`, not `abort()`. orpc's own
      // wrapper close-listener (`peer.close()`) tears the heartbeat stream
      // down WITHOUT sending a frame; firing our abort here would instead
      // make orpc fire-and-forget an ABORT_SIGNAL send onto the closed
      // socket (an unhandled DOM InvalidStateError). See
      // HeartbeatSubscriber.drop() for the full mechanism. The next
      // successful open re-subscribes via the onOpen hook above
      // (subscribe() is idempotent w.r.t. prior aborted loops).
      heartbeatSubscriber.drop();
      heartbeatMonitor.stop();
    },
    // Kick-specific teardown (F1/F3) — runs AFTER the onClose hook above
    // on the 4005 path, so the ordering mirrors dispose(): heartbeat
    // stops first, then the link/holder are cleared and the sleep
    // detector stops. See `ClientLifecycle.handleKicked`.
    onKicked: lifecycle.handleKicked,
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
  // (`sleepDetector` itself is declared in step 6b — the lifecycle
  // controller reads it lazily via `getSleepDetector`, so the binding
  // precedes the controller's construction.)
  const sleepDetectionEnabled = opts.sleepDetection !== false;
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

  // ----- 11. Upload strategy (optional) -----
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
        // NFI-3: a 401 on the upload channel is the same auth event as a WS
        // 1008/4001 close — feed it into the shared single-flight storm
        // guard. The strategy fires this on the raw HTTP 401 (only when the
        // rejected credential is still current — see H2 there); the manager
        // no-ops if the client is already dead (disposed/terminal/kicked).
        //
        // M3: wired ONLY when a real tokenProvider exists. Under cookie-auth
        // (no tokenProvider) there's nothing to refresh, so an upload 401
        // surfaces to the caller and the WS is left alone — consistent with
        // the locked cookie-auth caveat that only an actual auth-failure
        // *close* goes terminal without a provider (a stray upload 401 must
        // not tear down a healthy cookie-authed connection).
        onUpload401: hasTokenProvider
          ? () => {
              // L5: parity with the WS auth-recovery path (see
              // `onAuthRecoveryNeeded`) — surface `auth_failure` so the
              // consumer can show a brief "reconnecting" toast before the
              // WS visibly rolls over on the refreshed token.
              emit({ type: "auth_failure", refreshable: true });
              void reconnectManager.notifyUploadAuthFailure();
            }
          : undefined,
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
  // expected, JSON.stringify doesn't include it, etc.). The
  // public-signature → strategy-call bridge lives in
  // `upload/upload-method.ts`.
  // Gated on the lifecycle's unified dead predicate: a post-dispose (or
  // post-terminal / post-kick) upload() must reject BEFORE any network I/O
  // — the HTTP strategy lives outside the WS teardown path, so without the
  // gate it would still fire a real fetch and a 401 could emit events after
  // the client's documented death.
  const upload = uploadStrategy
    ? createUploadMethod<TContract>(uploadStrategy, lifecycle.isDead)
    : undefined;

  const client: OrpcWsClient<TContract> = {
    rpc,
    state: {
      getState: () => connectionState.getState(),
      subscribe: (cb) => connectionState.subscribe(cb),
    },
    connect: lifecycle.connect,
    // Bidi teardown rides the lifecycle's `disposeBidi` dep (wired above),
    // which every death path — dispose(), terminal auth, kicked — invokes
    // AFTER closing the wrapper (close-before-dispose; see
    // bidi/client-bidi.ts TEARDOWN ORDERING). Symmetric to the server
    // disposing its connection bidi from the ws 'close'.
    dispose: lifecycle.dispose,
  };
  if (upload) {
    client.upload = upload;
  }
  return client;
}
