import { defineConfig, devices } from "@playwright/test";

// The full stack (Keycloak + demo-server + demo-spa) is brought up as Docker
// containers by globalSetup (setup/containers.ts) — NOT by Playwright's
// `webServer`. The old `webServer` + `reuseExistingServer` approach silently
// reused a stale host dev server pointed at the wrong Keycloak, which was the
// root cause of local-only failures; containerising all three eliminates it.
//
// `baseURL` comes from E2E_SPA_URL (exported by globalSetup once the SPA
// container is up). The literal fallback keeps `--list` and config loading
// working before setup runs; it matches the fixed host port the stack binds.

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
    baseURL: process.env.E2E_SPA_URL ?? "http://localhost:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
