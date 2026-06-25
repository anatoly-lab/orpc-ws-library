import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../../vitest.config.base.ts";

// happy-dom: this package targets browsers (global `fetch`, `Headers`,
// `Request`/`Response`). happy-dom provides them so the tests run a real
// fetch surface — though we inject a fake `fetch` for determinism anyway.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@orpc-ws/cookie-bff-client",
      environment: "happy-dom",
      include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    },
  }),
);
