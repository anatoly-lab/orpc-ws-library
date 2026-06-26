// Playwright globalSetup.
//
// Brings up the WHOLE cookie-BFF stack (Keycloak + server + SPA) as Docker
// containers on one network, then polls each health endpoint until ready.
// This replaces the old hybrid where Playwright's `webServer` started the
// server + SPA as host dev processes — see setup/containers.ts header for
// why that was the root cause of local-only failures.
//
// The live stack handle lives on a module singleton inside containers.ts
// (not stashed on globalThis): Playwright serializes config across the
// worker boundary, so the handle can't travel through config — but the
// container handles do not need to reach the workers anyway. The specs only
// need the URLs, which we publish via process.env below. global-teardown
// imports stopStack() from the same module to reap them.

import {
  buildImages,
  startStack,
  type StackHandle,
} from "./containers.js";

/** Poll an HTTP endpoint until it returns 200, or throw after the deadline. */
async function waitForOk(
  url: string,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`[setup] ${label} not ready (${url}): ${lastErr}`);
}

/** Wait until every host-facing health endpoint reports ready. */
async function waitForSystemReady(stack: StackHandle): Promise<void> {
  await waitForOk(`${stack.serverUrl}/health/live`, "cookie-bff-server");
  await waitForOk(`${stack.spaUrl}/health`, "cookie-bff-spa");
}

export default async function globalSetup(): Promise<void> {
  console.log("[setup] Building images...");
  await buildImages();

  console.log("[setup] Starting stack...");
  const stack = await startStack();

  console.log("[setup] Waiting for system readiness...");
  await waitForSystemReady(stack);

  // Publish URLs for the specs / playwright.config baseURL. The container
  // handles stay on the containers.ts singleton for teardown.
  process.env.E2E_SPA_URL = stack.spaUrl;
  process.env.E2E_SERVER_URL = stack.serverUrl;
  process.env.E2E_KEYCLOAK_URL = stack.keycloakUrl;

  console.log(`[setup] System ready. SPA at ${stack.spaUrl}`);
}
