import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../../vitest.config.base.ts";

// Node environment — the cookie-BFF core is server-side (node:crypto) and
// never touches the DOM.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@orpc-ws/cookie-bff",
    },
  }),
);
