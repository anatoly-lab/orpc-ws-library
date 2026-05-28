// Playwright globalSetup.
//
// Boots Keycloak (testcontainers) and the demo server (host child
// process) once before the test run, then stashes handles on globalThis
// so global-teardown can stop them. Playwright's globalSetup intentionally
// has no other shared-state primitive — config is serialized across the
// worker boundary, so live container/process handles MUST live on the
// parent's globalThis.

import { startKeycloak, type KeycloakHandle } from "./containers.js";
import {
  buildDemos,
  startDemoServer,
  type DemoServerHandle,
} from "./demo-process.js";

// Augment globalThis so TS knows about the stashed handles.
declare global {
  var __keycloak: KeycloakHandle | undefined;
  var __demo: DemoServerHandle | undefined;
}

export default async function globalSetup(): Promise<void> {
  console.log("[setup] Building demos...");
  await buildDemos();

  console.log("[setup] Starting Keycloak...");
  const keycloak = await startKeycloak();
  console.log(`[setup] Keycloak ready at ${keycloak.url}`);

  // Keycloak realm fixture is `orpc-ws-demo`; the issuer URL is
  // `${keycloak.url}/realms/orpc-ws-demo`. That's the one OIDC config
  // value both the SPA and the server need.
  const issuerUrl = `${keycloak.url}/realms/orpc-ws-demo`;

  console.log("[setup] Starting demo server...");
  const demo = await startDemoServer({ OIDC_ISSUER_URL: issuerUrl });
  console.log(`[setup] Demo server ready at ${demo.url}`);

  globalThis.__keycloak = keycloak;
  globalThis.__demo = demo;

  // Tests can read these if they need to do raw HTTP against the IdP
  // (e.g. token introspection, admin actions for advanced scenarios).
  process.env.WEB_URL = demo.url;
  process.env.OIDC_ISSUER_URL = issuerUrl;
}
