// Express route-table introspection — the startup collision assert and the
// shadowed-nested-route warning `OrpcWsService` runs before registering the
// HTTP upload handler. One concept: reading Express's (undocumented but
// stable) layer stack to detect routes that would conflict with, or shadow,
// the upload path.
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
export interface ExpressLayer {
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
export interface ExpressApp {
  use: (path: string, ...handlers: unknown[]) => unknown;
  // Express 4 stashes the router on `_router`.
  _router?: { stack?: ExpressLayer[] };
  // Express 5 exposes the router as `router` (a function with a
  // `.stack` property). We type it loosely.
  router?: { stack?: ExpressLayer[] };
}

export function isExpressApp(instance: unknown): instance is ExpressApp {
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
export function assertNoExpressRouteCollision(
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
 * already throws on it. The same holds for nested CONTROLLER routes on
 * Express 4/Nest 10 — a route layer's `regexp.source` also contains the
 * path literal there, so a nested controller route is a hard boot
 * failure at the assert rather than this warn; the warn path applies on
 * Nest 11/Express 5.) Non-string `route.path` shapes (arrays,
 * regexes — raw-Express-only, Nest always passes strings) also fail
 * open.
 */
export function warnOnShadowedNestedRoutes(
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
