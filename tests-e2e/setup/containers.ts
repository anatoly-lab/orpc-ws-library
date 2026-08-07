// Full-stack Docker orchestration for the e2e run.
//
// Brings up the WHOLE cookie-BFF system as containers on one Docker network:
//   Keycloak (IdP)         ─┐
//   cookie-bff server      ─┼─ network "e2e" (aliases: keycloak / server / spa)
//   cookie-bff SPA (nginx) ─┘
//
// Containerising all three (rather than the old hybrid where Playwright's
// `webServer` started host dev processes while only Keycloak was a container)
// removes the "reuse a wrong-config process" foot-gun: `reuseExistingServer`
// could silently reuse a stale dev server pointed at the wrong Keycloak, so the
// issuer the server validated never matched the issuer the browser saw.
//
// ── The single-issuer model (the linchpin) ──────────────────────────────
// One issuer string, two network paths to reach it:
//   - PUBLIC issuer (what the BROWSER is redirected to for login + end-session,
//     and the token `iss` the server validates):
//       http://localhost:18080/realms/orpc-ws-demo
//   - INTERNAL discovery/JWKS + server-side code-exchange (server → KC over the
//     docker net):
//       http://keycloak:8080/realms/orpc-ws-demo
// Keycloak PINS its hostname (KC_HOSTNAME=http://localhost:18080 +
// KC_HOSTNAME_BACKCHANNEL_DYNAMIC=false) so it stamps `iss` and advertises
// discovery `issuer` = the PUBLIC url regardless of whether reached via host
// `localhost:18080` or internal `keycloak:8080`. The verifier
// (@orpc-ws/oidc-verifier-jose, used inside @orpc-ws/cookie-bff) fetches
// discovery from OIDC_DISCOVERY_URL (the internal host), validates the
// advertised `issuer` against the public OIDC_ISSUER_URL, and rewrites the
// advertised jwks_uri prefix to the internal host so the JWKS fetch also goes
// over the docker net.
//
// ── How cookie-BFF differs from the old PKCE stack ──────────────────────
// In PKCE the BROWSER ran the whole OAuth dance (authorize → token exchange in
// JS) and the SPA needed VITE_OIDC_* baked in. In cookie-BFF the SERVER runs
// the OAuth dance: the browser is only ever REDIRECTED to Keycloak (login form
// + end-session), and the auth `code` lands on the SERVER's /auth/callback
// (a server endpoint, NOT a SPA route). So:
//   - The SPA bakes only VITE_WS_URL + VITE_SERVER_ORIGIN (no OIDC, no upload).
//   - The realm registers the SERVER callback `http://localhost:18083/auth/callback`
//     as a redirect URI (Keycloak redirects the browser there over the host
//     port), and the SPA root `http://localhost:4173/*` as a post-logout URI.
//   - The server reads its OIDC/cookie/session config from RUNTIME env (it bakes
//     nothing), so all of it is injected below in startServer().
//
// ── Fixed host ports (NOT testcontainers' random ephemeral ports) ───────
// Keycloak 18080, server 18083, spa 4173. Two hard reasons:
//   1. The SPA's WS + server-origin URLs are baked at `vite build` time (Vite
//      inlines `import.meta.env.VITE_*`) — they can't depend on a port chosen
//      after the build runs.
//   2. The server's registered redirect URI + the browser's view of the server
//      origin must agree on one fixed URL, and the JWT `iss` the server
//      validates must match what the IdP stamped — same URLs on both sides.
// Trade-off: only one stack can run per host at a time. Fine for our
// single-worker Playwright setup.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  GenericContainer,
  Network,
  Wait,
  type StartedTestContainer,
  type StartedNetwork,
} from "testcontainers";

import {
  createLogBuffer,
  discardAllBuffers,
  dumpAllBuffers,
} from "./log-buffer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// tests-e2e/setup -> tests-e2e -> repo root.
const REPO_ROOT = path.resolve(here, "../..");

// ── images ──────────────────────────────────────────────────────────────
const KEYCLOAK_IMAGE = "quay.io/keycloak/keycloak:26.5.5";
const SERVER_IMAGE = "orpc-ws-e2e/server";
const SPA_IMAGE = "orpc-ws-e2e/spa";

const SERVER_DOCKERFILE = "apps/demo-cookie-bff/server/Dockerfile";
const SPA_DOCKERFILE = "apps/demo-cookie-bff/client/Dockerfile";

// ── realm / client ──────────────────────────────────────────────────────
const KEYCLOAK_REALM = "orpc-ws-demo";
// The server runs the server-side PKCE code-exchange as a PUBLIC client (no
// secret) against this same client — see cookie-auth.module.ts / config.ts
// (backendOidc.clientId defaults to OIDC_CLIENT_ID).
const OIDC_CLIENT_ID = "orpc-ws-demo-spa";

const KEYCLOAK_INTERNAL_PORT = 8080;
const SERVER_INTERNAL_PORT = 18083;
const SPA_INTERNAL_PORT = 80;

const KEYCLOAK_HOST_PORT = 18080;
const SERVER_HOST_PORT = 18083;
const SPA_HOST_PORT = 4173;

// ── public URLs (host-reachable; baked into the SPA + validated as `iss`) ──
const KEYCLOAK_PUBLIC_URL = `http://localhost:${KEYCLOAK_HOST_PORT}`;
const OIDC_ISSUER_URL = `${KEYCLOAK_PUBLIC_URL}/realms/${KEYCLOAK_REALM}`;
const SERVER_PUBLIC_URL = `http://localhost:${SERVER_HOST_PORT}`;
const SPA_PUBLIC_URL = `http://localhost:${SPA_HOST_PORT}`;
const WS_URL = `ws://localhost:${SERVER_HOST_PORT}/ws`;
// The SERVER's own /auth/callback — Keycloak redirects the BROWSER here over the
// host port, so it MUST be the host-reachable URL and MUST be registered as a
// redirect URI in the realm (setup/keycloak/orpc-ws-demo-realm.json).
const OIDC_REDIRECT_URI = `${SERVER_PUBLIC_URL}/auth/callback`;

// ── internal URLs (docker-net hostnames; server → KC over the network) ─────
const OIDC_DISCOVERY_URL = `http://keycloak:${KEYCLOAK_INTERNAL_PORT}/realms/${KEYCLOAK_REALM}`;

// ── fixed test secrets ────────────────────────────────────────────────────
// 32-byte AES-256-GCM key (base64) for at-rest token encryption. A FIXED value
// is fine for an ephemeral e2e stack — the sessions live only for the run, and
// the key never leaves this machine. (A real deployment sets a real secret via
// SESSION_ENC_KEY; rotating it invalidates existing sessions.) This is the same
// demo key the server's config.ts falls back to, made explicit here so the e2e
// env is self-documenting.
const SESSION_ENC_KEY = "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=";

// ── timeouts ──────────────────────────────────────────────────────────────
// First run pulls the 600+ MB KC image; subsequent runs are seconds.
const KEYCLOAK_STARTUP_TIMEOUT_MS = 5 * 60_000;
const APP_STARTUP_TIMEOUT_MS = 90_000;
// App images are large multi-stage builds (turbo prune + pnpm install + tshy).
// Cold build can be minutes; warm (layer-cached) build is seconds.
const IMAGE_BUILD_TIMEOUT_MS = 10 * 60_000;

export interface StackHandle {
  /** SPA base URL on the host — Playwright's baseURL. */
  spaUrl: string;
  /** cookie-bff server base URL on the host. */
  serverUrl: string;
  /** Keycloak base URL on the host. */
  keycloakUrl: string;
}

interface StartedStack {
  network: StartedNetwork;
  keycloak: StartedTestContainer;
  server: StartedTestContainer;
  spa: StartedTestContainer;
  handle: StackHandle;
}

// Module-level handle so global-teardown can stop what global-setup started.
// Playwright serializes config across the worker boundary, so the live
// container handles MUST live on a module singleton, not in config.
let started: StartedStack | null = null;

/**
 * Build the server + SPA images with FIXED tags via `docker build`.
 *
 * Why shell `docker build` (not GenericContainer.fromDockerfile): fixed tags
 * (`orpc-ws-e2e/server` / `orpc-ws-e2e/spa`) let Docker's layer cache make
 * warm runs fast. testcontainers' fromDockerfile generates a random image
 * name per build, defeating the cache. The build context is the REPO ROOT
 * (the Dockerfiles use `turbo prune`, which needs every workspace).
 *
 * The SPA image bakes 2 VITE_* build args (Vite inlines them at build time):
 * the WS URL + the server origin. The cookie-BFF SPA holds NO token and runs
 * no OIDC in the browser, so there are no VITE_OIDC_* / VITE_UPLOAD_URL args.
 * The server takes NO build args — it reads all config from env at runtime.
 *
 * execFileSync (not execSync): args are passed as an array, so there is no
 * shell interpolation of our build-arg URLs.
 */
export async function buildImages(): Promise<void> {
  console.log("[stack] Building app images (docker build, fixed tags)...");

  buildImage(SERVER_IMAGE, SERVER_DOCKERFILE, []);
  buildImage(SPA_IMAGE, SPA_DOCKERFILE, [
    "--build-arg",
    `VITE_WS_URL=${WS_URL}`,
    "--build-arg",
    `VITE_SERVER_ORIGIN=${SERVER_PUBLIC_URL}`,
  ]);

  console.log("[stack] App images built.");
}

function buildImage(tag: string, dockerfile: string, extraArgs: string[]): void {
  const start = Date.now();
  console.log(`[stack]   building ${tag} (${dockerfile})...`);
  execFileSync(
    "docker",
    ["build", "-f", dockerfile, "-t", tag, ...extraArgs, "."],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
      timeout: IMAGE_BUILD_TIMEOUT_MS,
    },
  );
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[stack]   [OK] ${tag} built in ${elapsed}s`);
}

/**
 * Start the full stack on a fresh network: Keycloak, then the server + SPA
 * containers (which depend on the IdP for runtime/build config respectively).
 *
 * On any failure mid-startup, buffered boot logs are flushed and every
 * partially-started container is reaped before re-throwing — so a boot crash
 * surfaces its logs instead of leaving an orphaned container behind.
 */
export async function startStack(): Promise<StackHandle> {
  if (started) {
    console.log("[stack] Already started; returning existing handle.");
    return started.handle;
  }

  let network: StartedNetwork | undefined;
  let keycloak: StartedTestContainer | undefined;
  let server: StartedTestContainer | undefined;
  let spa: StartedTestContainer | undefined;

  try {
    console.log("[stack] Creating Docker network...");
    network = await new Network().start();

    keycloak = await startKeycloak(network);
    server = await startServer(network);
    spa = await startSpa(network);

    const handle: StackHandle = {
      spaUrl: SPA_PUBLIC_URL,
      serverUrl: SERVER_PUBLIC_URL,
      keycloakUrl: KEYCLOAK_PUBLIC_URL,
    };

    started = { network, keycloak, server, spa, handle };

    // Happy path: release buffered boot logs — from here on the live
    // container handles can pull logs directly if a spec fails.
    discardAllBuffers();

    console.log("[stack] Stack up:", JSON.stringify(handle));
    return handle;
  } catch (err) {
    console.error("[stack] Startup failed; dumping logs and cleaning up...");
    // Flush buffered boot logs BEFORE reaping — once stopped, .logs() is empty.
    dumpAllBuffers();
    await safeStop({ network, keycloak, server, spa });
    throw err;
  }
}

/** Stop the stack in reverse dependency order (spa → server → keycloak → net). */
export async function stopStack(): Promise<void> {
  if (!started) {
    console.log("[stack] Nothing to stop.");
    return;
  }
  console.log("[stack] Stopping stack...");
  await safeStop(started);
  started = null;
  console.log("[stack] Stack stopped.");
}

/** Current handle if the stack is up, else null. */
export function getStackHandle(): StackHandle | null {
  return started?.handle ?? null;
}

/**
 * Dump the last N lines of a running container's combined log stream.
 * Used by teardown to surface server/spa logs when a spec failed.
 */
export async function dumpContainerLogs(
  which: "server" | "spa" | "keycloak",
  tailLines = 100,
): Promise<string> {
  if (!started) return "(no containers running)";
  const container = started[which];
  try {
    const stream = await container.logs();
    const lines: string[] = [];
    return await new Promise<string>((resolve) => {
      const finish = () =>
        resolve(lines.join("").split("\n").slice(-tailLines).join("\n"));
      stream.on("data", (c: Buffer) => lines.push(c.toString()));
      stream.on("end", finish);
      stream.on("error", () => finish());
      setTimeout(finish, 5_000);
    });
  } catch (err) {
    return `(failed to read ${which} logs: ${
      err instanceof Error ? err.message : String(err)
    })`;
  }
}

// ── individual container starters ─────────────────────────────────────────

async function startKeycloak(
  network: StartedNetwork,
): Promise<StartedTestContainer> {
  console.log("[stack] Starting Keycloak (pinned hostname)...");
  const realmDir = path.join(here, "keycloak");

  return new GenericContainer(KEYCLOAK_IMAGE)
    .withNetwork(network)
    .withNetworkAliases("keycloak")
    .withExposedPorts({
      container: KEYCLOAK_INTERNAL_PORT,
      host: KEYCLOAK_HOST_PORT,
    })
    .withCommand(["start-dev", "--import-realm"])
    .withEnvironment({
      // KEYCLOAK_ADMIN* were deprecated in 26.x; use the bootstrap vars.
      KC_BOOTSTRAP_ADMIN_USERNAME: "admin",
      KC_BOOTSTRAP_ADMIN_PASSWORD: "admin",
      KC_HEALTH_ENABLED: "true",
      KC_HTTP_ENABLED: "true",
      // ── issuer pinning ──
      // Full-URL hostname pins the public issuer Keycloak stamps + advertises.
      KC_HOSTNAME: KEYCLOAK_PUBLIC_URL,
      // Backchannel/server-side (internal keycloak:8080) requests would
      // otherwise derive the hostname from the request Host header — the exact
      // KC-26 `start-dev` default that broke the single-issuer model. Pinning
      // this to false makes the internal path advertise the PUBLIC issuer too,
      // so the discovery `issuer` matches from BOTH network paths.
      KC_HOSTNAME_BACKCHANNEL_DYNAMIC: "false",
    })
    .withCopyDirectoriesToContainer([
      { source: realmDir, target: "/opt/keycloak/data/import" },
    ])
    .withWaitStrategy(
      // Realm endpoint, NOT /health/ready: Keycloak flips health green before
      // --import-realm finishes, so /health/ready would race the realm import
      // and the first browser request could 404. The realm endpoint is 200
      // only after import completes.
      Wait.forHttp(`/realms/${KEYCLOAK_REALM}`, KEYCLOAK_INTERNAL_PORT)
        .forStatusCode(200)
        .withStartupTimeout(KEYCLOAK_STARTUP_TIMEOUT_MS),
    )
    .start();
}

async function startServer(
  network: StartedNetwork,
): Promise<StartedTestContainer> {
  console.log("[stack] Starting cookie-bff server...");
  // Attach the log buffer BEFORE .start() so a boot crash (e.g. bad OIDC
  // discovery) is captured even when the wait strategy times out.
  const logBuffer = createLogBuffer("server");

  return new GenericContainer(SERVER_IMAGE)
    .withNetwork(network)
    .withNetworkAliases("server")
    .withExposedPorts({
      container: SERVER_INTERNAL_PORT,
      host: SERVER_HOST_PORT,
    })
    .withLogConsumer(logBuffer.consumer)
    .withEnvironment({
      PORT: String(SERVER_INTERNAL_PORT),
      HOST: "0.0.0.0",
      // Public issuer: the token `iss` the server validates + the issuer the
      // BROWSER is redirected to for login/end-session.
      OIDC_ISSUER_URL,
      // Internal host: where the server fetches discovery + JWKS AND runs the
      // server-side code-exchange (the verifier validates the advertised issuer
      // against OIDC_ISSUER_URL and rewrites the jwks_uri prefix to this host).
      OIDC_DISCOVERY_URL,
      OIDC_CLIENT_ID,
      // The server's OWN /auth/callback — Keycloak redirects the browser here
      // over the host port; MUST match a redirect URI registered in the realm.
      OIDC_REDIRECT_URI,
      // The containerised SPA's host origin. First entry = the post-/auth/callback
      // 302 target + the post-logout target; whole list = the CORS allowlist
      // (credentials mode) AND the WS Origin allowlist (Decision #10). The e2e
      // SPA runs on exactly one origin, so this is a single value.
      SPA_ORIGIN_COOKIE_BFF: SPA_PUBLIC_URL,
      // Plain `sid` (the demo's localhost cookie config drops the prod-shaped
      // __Host-/Secure prefix — see cookie-auth.module.ts).
      SESSION_COOKIE_NAME: "sid",
      // Fixed at-rest token-encryption key for the ephemeral e2e stack.
      SESSION_ENC_KEY,
    })
    .withWaitStrategy(
      Wait.forHttp("/health/live", SERVER_INTERNAL_PORT)
        .forStatusCode(200)
        .withStartupTimeout(APP_STARTUP_TIMEOUT_MS),
    )
    .start();
}

async function startSpa(
  network: StartedNetwork,
): Promise<StartedTestContainer> {
  console.log("[stack] Starting cookie-bff SPA (nginx)...");
  // nginx rarely crashes, but the hook is cheap and surfaces config errors.
  const logBuffer = createLogBuffer("spa");

  return new GenericContainer(SPA_IMAGE)
    .withNetwork(network)
    .withNetworkAliases("spa")
    .withExposedPorts({ container: SPA_INTERNAL_PORT, host: SPA_HOST_PORT })
    .withLogConsumer(logBuffer.consumer)
    .withWaitStrategy(
      Wait.forHttp("/health", SPA_INTERNAL_PORT)
        .forStatusCode(200)
        .withStartupTimeout(APP_STARTUP_TIMEOUT_MS),
    )
    .start();
}

// ── teardown helper ────────────────────────────────────────────────────────

/**
 * Stop whatever is present in reverse dependency order, swallowing per-step
 * errors so one failed stop doesn't strand the rest (e.g. leak the network).
 */
async function safeStop(parts: {
  network?: StartedNetwork;
  keycloak?: StartedTestContainer;
  server?: StartedTestContainer;
  spa?: StartedTestContainer;
}): Promise<void> {
  // biome-ignore-start lint/suspicious/noEmptyBlockStatements: swallowing per-step stop errors IS this function, per the doc comment above
  await parts.spa?.stop().catch(() => {});
  await parts.server?.stop().catch(() => {});
  await parts.keycloak?.stop().catch(() => {});
  await parts.network?.stop().catch(() => {});
  // biome-ignore-end lint/suspicious/noEmptyBlockStatements: swallowing per-step stop errors IS this function
}
