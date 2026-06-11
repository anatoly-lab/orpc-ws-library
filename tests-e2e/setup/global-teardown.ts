// Playwright globalTeardown.
//
// Stops the whole containerised stack (spa → server → keycloak → network)
// via stopStack() from the same module that started it. Optionally dumps
// the server/spa container logs first — useful when a spec failed and you
// need to see what the server logged (set E2E_DUMP_LOGS=1).

import { dumpContainerLogs, stopStack } from "./containers.js";

export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_DUMP_LOGS === "1") {
    for (const which of ["server", "spa"] as const) {
      console.log(`\n=== ${which} logs ===`);
      console.log(await dumpContainerLogs(which, 100));
    }
  }

  try {
    await stopStack();
  } catch (err) {
    console.error("[teardown] stopStack failed:", err);
  }
}
