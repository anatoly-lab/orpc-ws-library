import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../../vitest.config.base.ts";

// happy-dom: this package targets browsers (uses `crypto.subtle`,
// `sessionStorage`/`localStorage`, `window.location`, `fetch`, etc.).
// happy-dom provides all of these including a working `crypto.subtle`
// (verified via `pkce.test.ts`'s RFC 7636 Appendix B fixture).
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@orpc-ws/oidc-pkce",
      environment: "happy-dom",
      include: [
        "src/**/*.test.ts",
        "src/**/__tests__/**/*.test.ts",
      ],
    },
  }),
);
