// Flat ESLint config (ESLint 9+).
//
// Enforces the "framework-free core" discipline from CLAUDE.md:
//   - packages/orpc-ws-client/src       — no react/vue/svelte/solid/nest imports
//   - packages/orpc-ws-server/src       — no nest/express/fastify imports
//   - packages/orpc-ws-server-nestjs/src — nest allowed (it's the adapter)
//   - packages/orpc-ws-react/src         — react allowed (it IS the adapter)
//
// Note: the implementation-plan.md showed the legacy .eslintrc shape with
// `from: ["node_modules/react", ...]` for `import/no-restricted-paths`.
// That worked in legacy config because zone `from` was matched against
// resolved paths. In flat config it's cleaner and more correct to combine
// path-scoped zones (`no-restricted-paths`) for *intra-repo* boundaries
// with `no-restricted-imports` for *npm-package* blocking. Same effect,
// idiomatic for flat config.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

/** Framework packages forbidden in the framework-free client core. */
const CLIENT_CORE_FORBIDDEN_PACKAGES = [
  "react",
  "react-dom",
  "vue",
  "svelte",
  "solid-js",
  "@nestjs/common",
  "@nestjs/core",
  "@nestjs/platform-express",
  "reflect-metadata",
];

/**
 * Packages forbidden in the framework-free BROWSER cookie-BFF client
 * (`@orpc-ws/cookie-bff-client`). The client-core framework bans PLUS the
 * Node-only / server-side cores it must never reach (it's the HTTP `/auth/*`
 * control plane only — no WS, no server packages, no `jose`).
 */
const COOKIE_BFF_CLIENT_FORBIDDEN_PACKAGES = [
  ...CLIENT_CORE_FORBIDDEN_PACKAGES,
  "express",
  "fastify",
  "ws",
  "jose",
  "@orpc-ws/server",
  "@orpc-ws/server-nestjs",
  "@orpc-ws/cookie-bff",
  "@orpc-ws/cookie-bff-nestjs",
  "@orpc-ws/oidc-verifier-jose",
];

/**
 * Framework packages forbidden in the framework-free server cores. Shared by
 * `@orpc-ws/server` and `@orpc-ws/cookie-bff` (the cookie-BFF core is just as
 * framework-free — its NestJS wiring lives in `@orpc-ws/cookie-bff-nestjs`).
 */
const SERVER_CORE_FORBIDDEN_PACKAGES = [
  "@nestjs/common",
  "@nestjs/core",
  "@nestjs/platform-express",
  "express",
  "fastify",
  "reflect-metadata",
];

// WS React adapter (`@orpc-ws/react`): the sole React adapter. Browser-only and
// WS-transport ONLY — it may use react / react-dom plus the browser-safe cores
// (@orpc-ws/client, @orpc/contract, @orpc/client), but must not reach a server
// core, a Node-only dep / `jose` / `ws`, another UI framework, or `react-router-dom`.
const WS_REACT_ADAPTER_FORBIDDEN_PACKAGES = [
  "@nestjs/common",
  "@nestjs/core",
  "@nestjs/platform-express",
  "reflect-metadata",
  "@orpc-ws/server",
  "@orpc-ws/server-nestjs",
  "@orpc-ws/oidc-verifier-jose",
  "jose",
  "ws",
  "express",
  "fastify",
  "vue",
  "svelte",
  "solid-js",
  "react-router-dom",
];

const restrictedImportRule = (patterns, message) => [
  "error",
  {
    paths: patterns.map((name) => ({ name, message })),
    patterns: patterns.map((name) => ({
      group: [`${name}/*`],
      message,
    })),
  },
];

export default tseslint.config(
  {
    // Global ignores.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      // Playwright outputs live in tests-e2e but aren't gitignored.
      // Linting their bundled trace/HTML JS produces hundreds of
      // false-positive errors; exclude both.
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Baseline for every TS source file in the repo.
    files: ["packages/*/src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
      // Note: not using `projectService`. None of the enabled rules need
      // type information; turning it on requires every file (incl. tests
      // excluded from per-package tsconfig.json) to be in some TS project,
      // which is friction. Re-add only if a type-aware rule lands.
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: ["packages/*/tsconfig.json"],
        },
        node: true,
      },
    },
    rules: {
      // SOLID / typing discipline.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Catches phantom imports — keeps each package's declared deps honest
      // (CLAUDE.md "Monorepo tooling: pnpm workspaces + Turborepo", the
      // no-phantom-imports note). pnpm's isolated node_modules already blocks
      // most phantom-dep access at runtime; this surfaces a missing
      // package.json declaration at lint time, a clearer failure.
      "import/no-extraneous-dependencies": [
        "error",
        {
          devDependencies: [
            "**/*.test.ts",
            "**/*.test.tsx",
            "**/*.spec.ts",
            "**/__tests__/**",
            "**/vitest.config.*",
            "**/eslint.config.*",
          ],
        },
      ],

      // Forbid console.* in library code (CLAUDE.md: "Zero console.log").
      "no-console": "error",
    },
  },

  // ---- Client core: framework-free ----
  //
  // The React bindings moved to `@orpc-ws/oidc-react`, so there's no
  // longer a `src/react/` exemption — the WHOLE client core src must obey
  // this rule. React etc. are forbidden everywhere under the core.
  {
    files: ["packages/orpc-ws-client/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictedImportRule(
        CLIENT_CORE_FORBIDDEN_PACKAGES,
        "Client core must remain framework-free; framework code lives in adapters (orpc-ws-oidc-react, etc.).",
      ),
    },
  },

  // ---- Server core: framework-free ----
  {
    files: ["packages/orpc-ws-server/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictedImportRule(
        SERVER_CORE_FORBIDDEN_PACKAGES,
        "Server core must remain framework-free; framework code lives in adapters (orpc-ws-server-nestjs, etc.).",
      ),
    },
  },

  // ---- Cookie-BFF core: framework-free ----
  //
  // Same framework-free discipline as the WS server core: `@orpc-ws/cookie-bff`
  // is the framework-agnostic cookie-BFF core (session-store seam, token
  // encryption, cookie/CSRF helpers). Its NestJS wiring lives in the sibling
  // `@orpc-ws/cookie-bff-nestjs` adapter.
  {
    files: ["packages/orpc-ws-cookie-bff/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictedImportRule(
        SERVER_CORE_FORBIDDEN_PACKAGES,
        "Cookie-BFF core must remain framework-free; framework code lives in adapters (orpc-ws-cookie-bff-nestjs, etc.).",
      ),
    },
  },

  // ---- Cookie-BFF client core: browser-only, framework-free ----
  //
  // `@orpc-ws/cookie-bff-client` is the browser `/auth/*` control-plane core
  // (typed /auth/me, in-memory synchronizer-CSRF token, mutate() wrapper,
  // login-URL builder). Like the WS client core it must stay UI-framework-free,
  // and additionally must never reach a server core / Node-only dep / `jose` /
  // `ws` — it's a pure browser HTTP client over global `fetch`.
  {
    files: ["packages/orpc-ws-cookie-bff-client/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictedImportRule(
        COOKIE_BFF_CLIENT_FORBIDDEN_PACKAGES,
        "The cookie-BFF client core is browser-only and framework-free; do not import UI frameworks, server cores, Node-only deps, jose, or ws.",
      ),
    },
  },

  // ---- WS React adapter: browser-only, WS-transport ONLY ----
  //
  // `@orpc-ws/react` binds the WS transport core to React — the sole React
  // adapter in the library. It must not reach into the router surface
  // (`react-router-dom`) or any server / Node-only / non-React-UI package.
  {
    files: ["packages/orpc-ws-react/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictedImportRule(
        WS_REACT_ADAPTER_FORBIDDEN_PACKAGES,
        "The WS React adapter is browser-only and WS-transport only; do not import server cores, Node-only deps, other UI frameworks, the OIDC auth core, or react-router-dom.",
      ),
    },
  },

  // ---- Demo apps (apps/*/src) — looser than library code by design ----
  //
  // The framework-free rules deliberately don't apply here: apps/* is the
  // composition layer where react / express / nest are expected. We still
  // keep the typing discipline (`no-explicit-any`, consistent type
  // imports) and `import/no-extraneous-dependencies` for phantom-import
  // catches, but `no-console` is off — demo apps log to console freely.
  {
    files: ["apps/*/src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { import: importPlugin },
    settings: {
      "import/resolver": {
        typescript: { project: ["apps/*/tsconfig.json"] },
        node: true,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "import/no-extraneous-dependencies": [
        "error",
        {
          devDependencies: [
            "**/*.test.ts",
            "**/*.test.tsx",
            "**/vite.config.*",
            "**/eslint.config.*",
          ],
        },
      ],
    },
  },

  // ---- Test files: relax a couple of rules ----
  {
    files: ["**/__tests__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  // ---- Config files at the root: Node-context, allow devDependencies. ----
  {
    files: ["*.{js,mjs,cjs,ts}", "**/vitest.config.{ts,mts}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "import/no-extraneous-dependencies": "off",
    },
  },
);
