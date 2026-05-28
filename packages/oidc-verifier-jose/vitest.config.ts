import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../../vitest.config.base.ts";

// Node environment — verifier is Node-only (no DOM globals needed).
// `fetch` / `Response` / `URL` are Node-native since 18.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@repo/oidc-verifier-jose",
    },
  }),
);
