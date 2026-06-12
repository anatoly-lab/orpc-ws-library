// Auth module barrel.
//
// Re-exported from the package root so consumers can write
// `import type { TokenProvider } from "@orpc-ws/client"` without
// reaching into a subpath. The barrel exists so the auth module's surface
// can grow (e.g. cookie-auth helpers) without churning consumer imports.

export type { TokenProvider } from "./token-provider.js";
export type { OnTerminalAuthFailure } from "./types.js";
