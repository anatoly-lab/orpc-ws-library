// Testcontainers Keycloak wrapper.
//
// Pattern lifted from anki-mcp-saas (tests/e2e/setup/containers.ts):
//   - quay.io/keycloak/keycloak:26.5.5 with `start-dev --import-realm`
//   - KC_BOOTSTRAP_ADMIN_USERNAME / KC_BOOTSTRAP_ADMIN_PASSWORD (the
//     deprecated KEYCLOAK_ADMIN env vars stopped working in 26.x)
//   - KC_HEALTH_ENABLED is enabled but we intentionally DO NOT use
//     `/health/ready` as the wait condition — Keycloak flips health
//     green before --import-realm finishes, causing a race where the
//     realm endpoint 404s on the first browser request from tests.
//     Instead we poll `/realms/<realm>` for 200, which is only true
//     after import completes.
//
// We don't use a `withNetwork` here: the demo server runs as a host
// process (cleaner stack trace, faster iteration than building yet
// another container image just for tests), so Keycloak only needs to
// be reachable from the host via its mapped port.

import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";

const here = path.dirname(fileURLToPath(import.meta.url));

const KEYCLOAK_IMAGE = "quay.io/keycloak/keycloak:26.5.5";
const KEYCLOAK_REALM = "orpc-ws-demo";
const KEYCLOAK_INTERNAL_PORT = 8080;
// 5 min — first run pulls the 600+ MB image; subsequent runs are seconds.
const KEYCLOAK_STARTUP_TIMEOUT_MS = 5 * 60_000;

export interface KeycloakHandle {
  /** Base URL on the host, e.g. `http://localhost:54321`. */
  url: string;
  container: StartedTestContainer;
  stop(): Promise<void>;
}

export async function startKeycloak(): Promise<KeycloakHandle> {
  const realmDir = path.join(here, "keycloak");

  const container = await new GenericContainer(KEYCLOAK_IMAGE)
    .withExposedPorts(KEYCLOAK_INTERNAL_PORT)
    .withCommand(["start-dev", "--import-realm"])
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_USERNAME: "admin",
      KC_BOOTSTRAP_ADMIN_PASSWORD: "admin",
      KC_HEALTH_ENABLED: "true",
      KC_HOSTNAME_STRICT: "false",
      KC_HTTP_ENABLED: "true",
    })
    .withCopyDirectoriesToContainer([
      { source: realmDir, target: "/opt/keycloak/data/import" },
    ])
    .withWaitStrategy(
      // Realm endpoint, NOT /health/ready: see comment at top of file.
      Wait.forHttp(`/realms/${KEYCLOAK_REALM}`, KEYCLOAK_INTERNAL_PORT)
        .forStatusCode(200)
        .withStartupTimeout(KEYCLOAK_STARTUP_TIMEOUT_MS),
    )
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(KEYCLOAK_INTERNAL_PORT);
  const url = `http://${host}:${port}`;

  return {
    url,
    container,
    stop: async () => {
      await container.stop();
    },
  };
}
