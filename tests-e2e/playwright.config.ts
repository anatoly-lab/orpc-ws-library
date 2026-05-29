import { defineConfig, devices } from "@playwright/test";

// Two webServers run concurrently:
//   1. demo-server on :18081 — Nest app hosting `/ws`. Built first via
//      turbo, then started via `node dist/main.js`.
//   2. demo-spa on :4173 — Vite preview of the SPA bundle. The `build`
//      step has to run with VITE_* env vars set, because Vite INLINES
//      `import.meta.env.VITE_*` at build time (not preview time).
//
// We pass static URLs because Keycloak is pinned to host port 18080
// (see setup/containers.ts) and the server is pinned to 18081 — the
// SPA's bundle is therefore built against deterministic strings. If
// Keycloak's port ever goes back to dynamic, this whole array breaks:
// `webServer.env` is evaluated at config-load time, before
// globalSetup runs, so a runtime port can't reach here.
//
// `reuseExistingServer: !process.env.CI` lets a dev iterate without
// killing whichever process is already up; CI always spawns fresh.

const KEYCLOAK_ISSUER = "http://localhost:18080/realms/orpc-ws-demo";
const OIDC_CLIENT_ID = "orpc-ws-demo-spa";
const SERVER_PORT = 18081;
const SPA_PORT = 4173;
const WS_URL = `ws://localhost:${SERVER_PORT}/ws`;

export default defineConfig({
  testDir: "./workflows",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["junit", { outputFile: "junit.xml" }],
  ],
  globalSetup: "./setup/global-setup.ts",
  globalTeardown: "./setup/global-teardown.ts",
  use: {
    baseURL: `http://localhost:${SPA_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Build the demo server (pulls @repo/* deps via turbo's ^build),
      // then run the compiled artifact. Mirrors what a consumer would
      // do in production.
      //
      // Readiness: `port` (not `url`). The demo server has no HTTP
      // routes — only the `/ws` upgrade handler — so `url` would 404,
      // and Playwright treats 404 as "not ready" (per the 2xx/3xx/400-403
      // contract). `port` just waits for the TCP listener to bind,
      // which is exactly what we want.
      name: "demo-server",
      command:
        "npx turbo run build --filter=@demo/server && npm run start -w @demo/server",
      port: SERVER_PORT,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PORT: String(SERVER_PORT),
        OIDC_ISSUER_URL: KEYCLOAK_ISSUER,
        OIDC_CLIENT_ID,
      },
    },
    {
      // Vite preview serves the built `dist/`. The build must run
      // FIRST and must see the VITE_* env (Vite inlines them).
      name: "demo-spa",
      command:
        "npx turbo run build --filter=@demo/spa && npm run preview -w @demo/spa",
      url: `http://localhost:${SPA_PORT}`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        VITE_OIDC_ISSUER_URL: KEYCLOAK_ISSUER,
        VITE_OIDC_CLIENT_ID: OIDC_CLIENT_ID,
        VITE_WS_URL: WS_URL,
      },
    },
  ],
});
