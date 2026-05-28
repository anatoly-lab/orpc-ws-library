// Heartbeat wire types and the library-reserved procedure path.
//
// Phase 3 NOTE: the *definitions* now live in `@repo/orpc-ws-shared` so the
// server core can import the same literal without a circular package
// dependency (server → client). The client keeps this barrel as the
// re-export shim so:
//
//   1. Existing imports from `./types.js` inside the client package
//      (subscriber, monitor, tests) keep working unchanged.
//   2. Consumers who import `HeartbeatEvent` / `HEARTBEAT_PATH` from
//      `@repo/orpc-ws-client` directly (Phase 1.5 public surface) keep
//      working unchanged.
//
// Server-side composition (Phase 3 `router-composer.ts`) and client-side
// subscription (Phase 1.5 `subscriber.ts`) still share ONE source of truth
// — that truth has just moved one package down the dependency chain.

export {
  HEARTBEAT_NAMESPACE,
  HEARTBEAT_PATH,
  type HeartbeatEvent,
} from "@repo/orpc-ws-shared";
