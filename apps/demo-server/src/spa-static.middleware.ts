// Serves the built Vite SPA from the demo server, on the same port as
// `/ws`. The single-process layout sidesteps CORS, removes the need for
// a second dev server, and matches how a small production deploy of an
// orpc-ws app would actually run.
//
// Two behaviors:
//   - assets (anything matched by `express.static`) are served from disk
//     verbatim with strong caching headers handled by express;
//   - everything else (the SPA's `/`, `/auth/callback`, deep links) falls
//     back to `index.html` with `window.__APP_CONFIG__` substituted in.
//
// `__APP_CONFIG__` is the runtime-config seam: the SPA is built once and
// can target any Keycloak realm / WS URL without rebuilding. The
// `index.html` shipped from Vite carries a literal placeholder
// `{{APP_CONFIG_JSON}}` we replace per-request. Cheap, no template engine.

import { readFile, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import { Logger } from "@nestjs/common";

import type { Request, Response, NextFunction, RequestHandler } from "express";
import express from "express";

/**
 * Runtime config the SPA sees on `window.__APP_CONFIG__`.
 *
 * Shape is OIDC-protocol-shaped, NOT IdP-shaped — the SPA's
 * `@repo/oidc-pkce` library is provider-agnostic, and the SPA's
 * config surface should mirror that. The server's env vars (which
 * stay `KEYCLOAK_*` for operator readability) get derived into this
 * shape in `main.ts`.
 */
export interface SpaRuntimeConfig {
  /**
   * OIDC issuer URL — browser-facing. Derived server-side as
   * `${KEYCLOAK_PUBLIC_URL ?? KEYCLOAK_URL}/realms/${REALM}` (or read
   * directly from `KEYCLOAK_ISSUER_URL` env var).
   */
  OIDC_ISSUER_URL: string;
  /** Public OIDC client ID registered with the IdP for the SPA. */
  OIDC_CLIENT_ID: string;
  /** WebSocket endpoint URL the SPA's ORPC client connects to. */
  WS_URL: string;
}

export interface SpaStaticOptions {
  /** Absolute path to the built Vite `dist/` directory. */
  dir: string;
  /** Runtime config injected into `index.html` at request time. */
  runtimeConfig: SpaRuntimeConfig;
}

const APP_CONFIG_PLACEHOLDER = "{{APP_CONFIG_JSON}}";

/**
 * Build an Express middleware that serves the SPA. Mount it AFTER the
 * `/ws` route is attached (the WS path is owned by the upgrade handler,
 * not the request pipeline, so order here is moot for that — but we keep
 * a defensive `next()` on the WS path anyway in case a non-upgrade GET
 * /ws ever slips in).
 *
 * NestJS's `app.use(...)` accepts a single `RequestHandler`, so we
 * compose the static-asset middleware and the index-fallback into one
 * function.
 */
export function spaStaticMiddleware(opts: SpaStaticOptions): RequestHandler {
  const logger = new Logger("SpaStaticMiddleware");
  const indexPath = join(opts.dir, "index.html");
  const runtimeConfigJson = JSON.stringify(opts.runtimeConfig);
  // express.static covers asset GETs; anything not on disk falls through
  // to the next handler.
  const staticHandler = express.static(opts.dir, {
    index: false,
    fallthrough: true,
  });

  let cachedIndex: string | null = null;

  const loadIndex = async (): Promise<string> => {
    if (cachedIndex !== null) return cachedIndex;
    try {
      const raw = await readFile(indexPath, "utf8");
      cachedIndex = raw;
      return raw;
    } catch (err) {
      // Fail gracefully — when the SPA hasn't been built yet (or this
      // process runs without the demo-spa dist), don't take the server
      // down; return a small inline message so a probe can still discover
      // the server's alive (`/ws` still works).
      logger.warn(
        `SPA index.html not found at ${indexPath} (run \`npm -w @demo/spa run build\`?): ${err instanceof Error ? err.message : String(err)}`,
      );
      return `<!doctype html><html><body><pre>demo-spa not built. index.html missing at ${indexPath}.</pre></body></html>`;
    }
  };

  const renderIndex = async (): Promise<string> => {
    const raw = await loadIndex();
    // replaceAll: index.html may carry the placeholder twice (once in
    // the explanatory comment and once in the actual script tag). Both
    // should be substituted; the comment is harmless but inconsistent
    // otherwise.
    return raw.replaceAll(APP_CONFIG_PLACEHOLDER, runtimeConfigJson);
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    // Don't intercept /ws — that's the WebSocket upgrade endpoint.
    // Defensive: `app.use` runs for HTTP requests; a non-upgrade GET /ws
    // would reach here and we just decline.
    if (req.path === "/ws" || req.path.startsWith("/ws/")) {
      next();
      return;
    }
    // Only handle GET / HEAD requests; POSTs etc. shouldn't be served
    // from the SPA.
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    // 1. Try the static asset path first.
    staticHandler(req, res, (staticErr) => {
      if (staticErr) {
        next(staticErr);
        return;
      }
      if (res.headersSent) {
        return;
      }

      // 2. SPA fallback — serve index.html with config substituted.
      void (async () => {
        try {
          // Guard against directory-traversal: if the requested path
          // resolves outside dir, fall through to next.
          const requested = normalize(req.path);
          if (requested.includes("..")) {
            next();
            return;
          }
          // If a file with this exact name exists, express.static would
          // already have served it; we got here because either it's a
          // SPA route or a typo. Either way, hand them index.html.
          // We do one stat check so true 404s for asset extensions
          // (e.g. /assets/missing.js) get a 404 instead of HTML — that
          // makes broken script tags easier to debug.
          if (/\.[a-zA-Z0-9]+$/.test(requested) && requested !== "/index.html") {
            try {
              await stat(join(opts.dir, requested));
            } catch {
              res.status(404).type("text/plain").send("Not found");
              return;
            }
          }

          const html = await renderIndex();
          res.status(200).type("html").send(html);
        } catch (err) {
          next(err);
        }
      })();
    });
  };
}
