// `@Injectable` wrapper around the framework-free `OrpcWsServer` core.
//
// Lifecycle bridging:
//   - constructor:      eagerly instantiates the core (collision check
//                       on the consumer's router runs HERE per
//                       CLAUDE.md "Heartbeat ownership"). Surfacing the
//                       failure at construction time means Nest's
//                       bootstrap fails fast, not on first WS connect.
//   - OnApplicationBootstrap: grabs `httpAdapter.getHttpServer()` from
//                       `HttpAdapterHost` and calls `server.attach()`.
//                       This fires AFTER every module's onModuleInit
//                       resolves, AFTER the underlying HTTP server has
//                       been created by Nest, but BEFORE `app.listen()`
//                       binds the port. Attaching here is the documented
//                       safe seam.
//   - BeforeApplicationShutdown: calls `server.dispose()` BEFORE the
//                       HTTP server is torn down — so clients receive
//                       the 4009 close frame on the open socket, NOT a
//                       TCP RST. See packages/orpc-ws-server/src/
//                       __tests__/integration/dispose-ordering.test.ts
//                       for the corresponding core invariant.
//
// `getServer()` exposes the raw core for advanced consumers (custom
// broadcast policies, observability hooks, etc.). `broadcast` /
// `closeUser` are convenience pass-throughs so the most common
// imperative ops don't require unwrapping the core.

import {
  Inject,
  Injectable,
  Logger as NestLogger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";

import {
  type AnyContractRouter,
  type OrpcWsServer,
  type ServerConnection,
  createAuthlessOrpcWsServer,
  createOrpcWsServer,
} from "@orpc-ws/server";

import { ORPC_WS_OPTIONS } from "./orpc-ws.module-builder.js";
import type { OrpcWsModuleOptions } from "./orpc-ws.options.js";

/**
 * Erased-type alias for the core server. The NestJS adapter holds the
 * server behind a DI provider that has no type-param erasure path —
 * `<TUser, TContract>` would force consumers to inject a typed wrapper
 * everywhere. Consumers who need the narrow types call `getServer()`
 * and cast at the call site (single seam, single cast).
 */
type AnyOrpcWsServer = OrpcWsServer<unknown, object>;

@Injectable()
export class OrpcWsService
  implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly server: AnyOrpcWsServer;
  private readonly logger = new NestLogger(OrpcWsService.name);

  constructor(
    @Inject(ORPC_WS_OPTIONS)
    private readonly options: OrpcWsModuleOptions,
    // `@Inject(HttpAdapterHost)` (rather than type-only injection) keeps
    // `HttpAdapterHost` as a value import — without it, `verbatimModuleSyntax`
    // would force `import type` and `emitDecoratorMetadata` would have no
    // class reference to encode for Nest's DI lookup.
    @Inject(HttpAdapterHost)
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {
    // Eager core construction = eager collision check on
    // `__orpc_ws_lib__` in the consumer's router. Bug-surface decision
    // documented in CLAUDE.md "Heartbeat ownership — stealth procedure
    // pattern": consumers see the error during Nest bootstrap, not on
    // first WS connection minutes later.
    //
    // Mode dispatch: `mode: "authless"` routes to the authless factory
    // (no verifyClient, accepts every upgrade, empty context); absent or
    // `"authenticated"` uses the authed factory. The authless factory's
    // return type omits `closeUser`, but that omission is COMPILE-TIME
    // only: at runtime it's the same core class, and casting to the
    // erased `AnyOrpcWsServer` (the DI surface can't carry the per-mode
    // narrowing) re-exposes it. `closeUser` works by registry key in ANY
    // mode — in the default authless single-connection mode the key is
    // the exported SINGLE_AUTHLESS_KEY, so
    // `service.closeUser(SINGLE_AUTHLESS_KEY, ...)` really does kick the
    // live connection (see the pass-through below).
    // Exhaustive dispatch: pairing `undefined`/`"authenticated"` keeps the
    // back-compat default (absent mode ⇒ authenticated). The `never` guard
    // makes a future mode a COMPILE error and a bad runtime value (typo via
    // the type-erased DI factory, e.g. `"authles"`) fail loud HERE — not
    // silently fall through to the authenticated factory and surface later
    // as a misleading "missing verifyClient" error.
    switch (this.options.mode) {
      case undefined:
      case "authenticated":
        this.server = createOrpcWsServer(this.options);
        break;
      case "authless":
        this.server = createAuthlessOrpcWsServer(this.options) as AnyOrpcWsServer;
        break;
      default: {
        const _exhaustive: never = this.options;
        void _exhaustive;
        throw new Error(
          `OrpcWsModule: unknown mode ${JSON.stringify(
            (this.options as { mode?: unknown }).mode,
          )} (expected "authenticated", "authless", or omitted).`,
        );
      }
    }
  }

  /**
   * Register the upload HTTP route during `onModuleInit`.
   *
   * Why `onModuleInit` and not `onApplicationBootstrap` — verified
   * against @nestjs/core 11.1.27 `nest-application.js` `init()`, which
   * runs, in order:
   *   registerParserMiddleware → registerModules → registerRouter
   *   → callInitHook (onModuleInit) → registerRouterHooks.
   * Controller routes are therefore ALREADY on the Express app when
   * this hook runs — our `app.use(httpPath, handler)` lands AFTER
   * every controller, not before Nest's router. What makes this hook
   * still work is `registerRouterHooks`: Nest's catch-all 404 handler
   * (`routes-resolver.js` → `registerNotFoundHandler`, the layer that
   * throws NotFoundException) is appended only AFTER `onModuleInit`,
   * so an unmatched request falls through the controller layers,
   * reaches our middleware, and only hits the 404 if we `next()`.
   * Registering at `onApplicationBootstrap` instead would land AFTER
   * that 404 catch-all — every /upload/* request would get Nest's
   * NotFoundException JSON and never reach us.
   *
   * Corollary: a consumer controller route on a path UNDER `httpPath`
   * sits earlier in the stack and wins over our handler for that
   * path+method — see the shadowing warning in
   * `maybeRegisterHttpUploadRoute`.
   *
   * HttpAdapterHost is populated during the very early phase of
   * `app.init()` (before module init hooks run), so it's available.
   */
  onModuleInit(): void {
    // ----- Phase 6: HTTP upload route registration -----
    // Mount the HTTP RPCHandler on the Express app instance when uploads
    // are enabled. CLAUDE.md "Architectural decisions for this phase"
    // point 4 (option 1: raw Express registration) — the cross-phase
    // simpler path. The handler signature is Express-middleware-compatible
    // `(req, res, next)`, so `app.use(path, handler)` works directly.
    //
    // Express-only: Fastify is documented as TBD (README), so we don't
    // try to handle the Fastify adapter case here.
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    if (!httpAdapter) return; // Will throw at onApplicationBootstrap if still null.
    this.maybeRegisterHttpUploadRoute(httpAdapter);
  }

  onApplicationBootstrap(): void {
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    if (!httpAdapter) {
      // Defensive — would only fire if Nest's bootstrap order ever
      // changed to run application bootstrap before the HTTP adapter
      // was created. Today it's wired the other way: HTTP adapter
      // instantiation happens during app.init(), bootstrap hook runs
      // after. We surface the error explicitly so a future Nest
      // version regression is obvious.
      throw new Error(
        "OrpcWsService: HttpAdapter was not initialized at OnApplicationBootstrap. " +
          "Ensure @nestjs/platform-express (or a compatible HTTP adapter) is configured.",
      );
    }

    const httpServer = httpAdapter.getHttpServer();
    this.server.attach(httpServer);

    const path = this.options.connection?.path ?? "/ws";
    this.logger.log(`ORPC WebSocket server attached at ${path}`);
  }

  /**
   * If uploads is enabled, register the HTTP handler on the underlying
   * Express app. Asserts that the path isn't already taken by an existing
   * Express route — surfacing the collision at bootstrap (a hard fail) is
   * much more debuggable than a silent first-route-wins surprise at
   * runtime — and warns about consumer routes nested UNDER the path,
   * which would shadow individual procedures (see below).
   *
   * The route-scans look at Express's internal `app._router.stack`
   * (Express 4) / `app.router.stack` (Express 5) — undocumented but
   * stable. We tolerate the shape possibly not existing (e.g. routes
   * registered lazily) and skip the checks in that case rather than
   * throwing on a missing internal.
   */
  private maybeRegisterHttpUploadRoute(httpAdapter: {
    getInstance: () => unknown;
  }): void {
    const handler = this.server.getHttpHandler();
    if (!handler) return; // Uploads disabled — nothing to register.

    const uploadConfig = this.server.getUploadConfig();
    const httpPath = uploadConfig.httpPath;

    const appInstance = httpAdapter.getInstance();
    if (!isExpressApp(appInstance)) {
      throw new Error(
        "OrpcWsService: uploads requires an Express-compatible HTTP adapter. " +
          "Fastify support is not yet implemented (see README).",
      );
    }

    // Startup assertion: collision check. This scans Express's layer
    // stack for a layer that claims `httpPath` ITSELF: an exact
    // `route.path` match, an Express 4 `app.use` regexp whose source
    // contains the path literal, or an Express 5 matcher that matches
    // `httpPath`. It does NOT catch consumer routes nested UNDER the
    // prefix — those are the warn-only scan's job, below.
    assertNoExpressRouteCollision(appInstance, httpPath);

    // Shadowing detection: on Nest 11 controller routes register BEFORE
    // this hook runs (registerRouter precedes callInitHook — see the
    // onModuleInit docstring), so a consumer route nested UNDER
    // `httpPath` (e.g. @Controller("upload") + @Post("media/upload")
    // → /upload/media/upload) sits earlier in the stack and silently
    // wins over our catch-all for that path+method. We WARN rather than
    // throw: apps already running with such a (mis)configuration boot
    // fine today, and turning that latent shadowing into a hard boot
    // failure would be a breaking behavior change. The exact-path
    // collision above stays a throw, as before.
    warnOnShadowedNestedRoutes(appInstance, httpPath, this.logger);

    // Register. `app.use(path, handler)` makes the handler the catch-all
    // under that prefix for ANY method (POST, OPTIONS for CORS preflight,
    // etc.). ORPC's RPCHandler decides per-procedure what to do.
    appInstance.use(httpPath, handler);

    this.logger.log(
      `ORPC HTTP upload handler registered at ${httpPath}` +
        (uploadConfig.bodyLimitBytes !== undefined
          ? ` (body limit: ${uploadConfig.bodyLimitBytes} bytes)`
          : ""),
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    // BEFORE Nest closes the HTTP server — clients see the explicit
    // 4009 (shutdownCloseCode) frame instead of a TCP RST. The core's
    // dispose() handles ordering internally (heartbeat stop → close
    // sockets → close WSS).
    this.logger.log(
      "ORPC WebSocket server shutting down (sending close to all clients)...",
    );
    await this.server.dispose();
  }

  /**
   * Escape hatch for advanced consumers — observability, tests, future
   * broadcast policies (Phase 6 will add `broadcast` to the core).
   * Most consumers only need the `closeUser` convenience below.
   */
  getServer(): AnyOrpcWsServer {
    return this.server;
  }

  /** Convenience pass-through: close a specific user's connection. */
  closeUser(
    ...args: Parameters<AnyOrpcWsServer["closeUser"]>
  ): ReturnType<AnyOrpcWsServer["closeUser"]> {
    return this.server.closeUser(...args);
  }

  /**
   * Look up a live connection by its registry key — the out-of-band entry
   * point for server→client RPC. Mirrors the core's `server.getConnection`:
   * returns the `conn` handle (`{ key, user, ws }`, plus the typed
   * server→client `client` caller when the server was built with a
   * `clientContract`) or `undefined`. The bidi call site is then
   * `service.getConnection<MyClientContract>(key)?.client.notify(payload)`.
   *
   * TYPING CHOICE — generic METHOD, not a generic class. A NestJS provider is
   * injected by token; its instance type can't carry per-app type params
   * (`@Inject(OrpcWsService)` has nowhere to put `<TClientContract>`), so the
   * class stays type-erased exactly like `getServer()` / `closeUser`. The
   * caller supplies `TClientContract` at the call site instead; absent it, the
   * `never` default yields a `conn` with NO `client` (opt-in: a non-bidi
   * consumer can't reach a caller that doesn't exist). `user` stays `unknown`
   * (the same erasure `getServer()` carries); a consumer needing the typed
   * principal narrows via `getServer()`.
   *
   * The cast names the erasure seam: the underlying `AnyOrpcWsServer` is typed
   * `TClientContract = never`, so its `getConnection` is re-narrowed here to
   * the caller-supplied contract — the same idiom the core uses internally to
   * re-narrow its registry's `unknown`-typed `client`.
   *
   * CALL-SITE/CONFIG HAZARD — the `TClientContract` you pass here is DECOUPLED
   * from the module's actual config, so it is on YOU to keep them matched: the
   * generic must name the same `clientContract` the module was built with.
   * Calling `getConnection<SomeContract>(key)` against a module configured
   * WITHOUT a `clientContract` types `.client` as PRESENT while it is
   * `undefined` at runtime — a `conn.client.notify(...)` then compiles but
   * crashes. Supply the generic only for a genuinely bidi module; for a
   * non-bidi module leave it at the `never` default (no `.client`).
   */
  getConnection<TClientContract extends AnyContractRouter = never>(
    key: string,
  ): ServerConnection<unknown, TClientContract> | undefined {
    return this.server.getConnection(key) as
      | ServerConnection<unknown, TClientContract>
      | undefined;
  }
}

// ----- Express route-table introspection -----
//
// Express's internals are stable enough across 4.x and 5.x to scan for
// route collisions, but the shapes are NOT publicly typed. We use minimal
// structural guards here — anything we don't recognize is treated as
// "no collision detectable", which fails OPEN. That's the right tradeoff:
// a false negative just means we miss a collision warning, while a false
// positive (rejecting a legitimate config) would block the consumer's
// app from starting.

/**
 * Layer-shape we read from Express's route table. Both Express 4 and
 * Express 5 stacks expose `route` (for `app.get/post/...`) and either
 * `regexp.source` (Express 4 `app.use`) or `matchers` (Express 5
 * `app.use`). We probe both shapes and tolerate either being absent.
 */
interface ExpressLayer {
  /** Set for `app.get("/foo")` etc. */
  route?: { path?: string };
  /** Set for `app.use("/foo")` in Express 4. */
  regexp?: { source?: string };
  /**
   * Set for `app.use("/foo")` in Express 5. Each matcher is a function
   * taking a request path and returning a match descriptor or `false`.
   */
  matchers?: Array<(path: string) => unknown>;
}

/**
 * Structural shape we look for on the Express app instance. Both the
 * `use()` method (Express 4) and `_router.stack` / `router.stack`
 * (Express 4 / 5) are stable enough that consumers relying on them
 * is the de-facto API.
 */
interface ExpressApp {
  use: (path: string, ...handlers: unknown[]) => unknown;
  // Express 4 stashes the router on `_router`.
  _router?: { stack?: ExpressLayer[] };
  // Express 5 exposes the router as `router` (a function with a
  // `.stack` property). We type it loosely.
  router?: { stack?: ExpressLayer[] };
}

function isExpressApp(instance: unknown): instance is ExpressApp {
  return (
    typeof instance === "function" ||
    (typeof instance === "object" &&
      instance !== null &&
      typeof (instance as { use?: unknown }).use === "function")
  );
}

/**
 * Throws if Express's route table already includes a layer claiming
 * `httpPath` itself. Routes nested UNDER the path are NOT this check's
 * concern (see `warnOnShadowedNestedRoutes`). Stays defensive: if the
 * internals don't expose a stack, we skip the check rather than
 * crashing.
 *
 * Two-shape probe (Express 4 + 5):
 *   - Exact `route.path === path` — covers `app.get/post(path, ...)`.
 *   - Express 4: `regexp.source` includes the path literal. (Note this
 *     one IS over-broad — an Express 4 layer nested under the path also
 *     contains the literal and therefore throws. Pre-existing behavior,
 *     deliberately unchanged.)
 *   - Express 5: any matcher function returns truthy for the path.
 *     Pathless middleware (e.g. body parsers) returns false here —
 *     verified against express 5.2.1 — so it doesn't false-positive.
 */
function assertNoExpressRouteCollision(
  app: ExpressApp,
  httpPath: string,
): void {
  const stack = app._router?.stack ?? app.router?.stack;
  if (!stack) return;

  const conflicting = stack.find((layer) => {
    // 1. Exact route match.
    if (layer.route?.path === httpPath) return true;
    // 2. Express 4: regexp source contains the path literal.
    const src = layer.regexp?.source;
    if (typeof src === "string" && src.includes(httpPath)) return true;
    // 3. Express 5: run the path through the matcher functions.
    if (Array.isArray(layer.matchers)) {
      for (const m of layer.matchers) {
        if (typeof m === "function" && m(httpPath)) return true;
      }
    }
    return false;
  });

  if (conflicting) {
    throw new Error(
      `OrpcWsService: cannot register the upload handler at "${httpPath}" — ` +
        `an existing Express route or middleware already occupies this path. ` +
        `Choose a different uploads.httpPath, or remove the conflicting route.`,
    );
  }
}

/**
 * Warn-only scan for consumer ROUTE layers registered strictly UNDER
 * the upload prefix. On Nest 11 controller routes land on the Express
 * app before this adapter's middleware (registerRouter runs before
 * callInitHook), so such a route sits earlier in the stack and shadows
 * the RPC procedure at the same path — uploads to it hit the controller,
 * not the upload handler.
 *
 * Scope: route layers only (`route.path` is a string in both Express 4
 * and 5, so no regexp/matcher probing is needed) — exactly the shape
 * Nest controllers produce. `app.use` layers are deliberately NOT
 * probed: Express 5 exposes only opaque matcher functions for them (no
 * at-rest mount path), and guessing sub-paths to probe would invite
 * false positives — we fail open, consistent with this section's
 * stance. (On Express 4 a nested `app.use` never reaches this scan
 * anyway: the regexp-source check in `assertNoExpressRouteCollision`
 * already throws on it.) Non-string `route.path` shapes (arrays,
 * regexes — raw-Express-only, Nest always passes strings) also fail
 * open.
 */
function warnOnShadowedNestedRoutes(
  app: ExpressApp,
  httpPath: string,
  logger: { warn: (message: string) => void },
): void {
  const stack = app._router?.stack ?? app.router?.stack;
  if (!stack) return;

  const prefix = httpPath.endsWith("/") ? httpPath : `${httpPath}/`;
  for (const layer of stack) {
    const routePath = layer.route?.path;
    if (typeof routePath === "string" && routePath.startsWith(prefix)) {
      logger.warn(
        `A route at "${routePath}" is registered under the upload path ` +
          `"${httpPath}" and will shadow the upload handler for that path ` +
          `(controller routes register before this middleware on NestJS 11). ` +
          `Move the route, or choose a different uploads.httpPath.`,
      );
    }
  }
}
