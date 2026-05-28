import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../../vitest.config.base.ts";

// Node environment — the server core never touches the DOM.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@repo/orpc-ws-server",
    },
  }),
);
