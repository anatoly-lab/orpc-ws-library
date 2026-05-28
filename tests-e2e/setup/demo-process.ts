// Demo server child-process orchestration.
//
// The demo server is a NestJS app at apps/demo-server. We could run
// it via `tsx` for speed, but the Playwright suite wants to exercise
// the *built* artifacts (closer to what consumers will run). So we:
//
//   1. Build both apps via turbo (cached — no-op on incremental runs)
//   2. spawn `node dist/main.js` with env wired to the live IdP
//   3. Poll `/` for 200 (the SPA index served by spaStaticMiddleware)
//
// Env shape is OIDC-generic — one `issuerUrl` covers both the SPA's
// `@repo/oidc-pkce` (Discovery → endpoints) and the server's
// `createOidcVerifyClient` (Discovery → jwks_uri + issuer).
//
// stdout/stderr are piped into a ring buffer rather than the parent's
// stdio so green runs stay clean. On failure, Playwright's reporter
// (or globalTeardown) flushes the buffer to surface server logs.

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LogBuffer } from "./log-buffer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// `tests-e2e/setup/demo-process.ts` -> repo root is ../../
const REPO_ROOT = path.resolve(here, "../..");
const DEMO_SERVER_DIR = path.join(REPO_ROOT, "apps", "demo-server");
const DEMO_SERVER_ENTRY = path.join(DEMO_SERVER_DIR, "dist", "main.js");

const DEMO_PORT = 18081;
const DEMO_STARTUP_TIMEOUT_MS = 30_000;
const DEMO_POLL_INTERVAL_MS = 500;

export interface DemoServerEnv {
  /** OIDC issuer URL — both browser and server reach the IdP at this URL. */
  OIDC_ISSUER_URL: string;
  /** Public OIDC client ID registered with the IdP. */
  OIDC_CLIENT_ID?: string;
  WS_URL?: string;
}

export interface DemoServerHandle {
  url: string;
  process: ChildProcess;
  logs: LogBuffer;
  stop(): Promise<void>;
}

/**
 * Build the demo SPA + server. Turbo handles dep ordering and caching.
 * On a warm cache this is sub-second.
 */
export async function buildDemos(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "npx",
      [
        "turbo",
        "run",
        "build",
        "--filter=@demo/spa",
        "--filter=@demo/server",
      ],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: process.env,
        shell: process.platform === "win32",
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`turbo build exited with code ${code}`));
    });
  });
}

/**
 * Spawn the demo server as a child process with the supplied OIDC env.
 * Resolves once `/` returns 200 (SPA index).
 *
 * `OIDC_ISSUER_URL` is what the browser hits during PKCE AND what the
 * server uses for Discovery → JWKS. This setup runs the server on the
 * host alongside the IdP's host-mapped port, so one URL covers both
 * reach paths.
 */
export async function startDemoServer(
  env: DemoServerEnv,
): Promise<DemoServerHandle> {
  const fullEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(DEMO_PORT),
    OIDC_ISSUER_URL: env.OIDC_ISSUER_URL,
    OIDC_CLIENT_ID: env.OIDC_CLIENT_ID ?? "orpc-ws-demo-spa",
    WS_URL: env.WS_URL ?? `ws://localhost:${DEMO_PORT}/ws`,
  };

  const logs = new LogBuffer("demo-server");
  const child = spawn("node", [DEMO_SERVER_ENTRY], {
    cwd: DEMO_SERVER_DIR,
    env: fullEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk) => logs.write(chunk));
  child.stderr?.on("data", (chunk) => logs.write(chunk));

  // If it exits before we see a 200, surface logs immediately —
  // otherwise globalSetup just times out with no context. `stopping`
  // flips true once we send SIGTERM ourselves so we don't log the
  // teardown-triggered exit as unexpected.
  let exited = false;
  let stopping = false;
  child.on("exit", (code, signal) => {
    exited = true;
    if (stopping) return;
    console.error(
      `[demo-server] exited unexpectedly code=${code} signal=${signal}\n${logs.flush()}`,
    );
  });

  const url = `http://localhost:${DEMO_PORT}`;
  const deadline = Date.now() + DEMO_STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `demo-server exited during startup. Logs:\n${logs.flush()}`,
      );
    }
    try {
      const resp = await fetch(`${url}/`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (resp.ok) {
        return {
          url,
          process: child,
          logs,
          stop: async () => {
            stopping = true;
            await stopChild(child);
          },
        };
      }
    } catch {
      // not ready yet
    }
    await sleep(DEMO_POLL_INTERVAL_MS);
  }

  // Timeout: kill the child and dump what we have.
  await stopChild(child);
  throw new Error(
    `demo-server failed to respond at ${url}/ within ${DEMO_STARTUP_TIMEOUT_MS}ms.\n${logs.flush()}`,
  );
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
