// Auth-module supporting types.
//
// Phase 1.3 NEW file. Keeps callback typedefs separate from the TokenProvider
// interface itself so the composition root (Phase 1.7) can import the
// callback type without dragging the provider contract along.

/**
 * Called when the library has given up on auth recovery PERMANENTLY for
 * this client instance. Reasons:
 *   - `TokenProvider.refresh()` returned null
 *   - The 30s storm-guard window tripped (refresh attempt within 30s of the
 *     previous one — treated as a hot-loop signal)
 *
 * The consumer typically uses this for app-level cleanup: clearing in-memory
 * auth state, redirecting to /login, etc. The library has already moved the
 * connection to a disconnected state and (in the storm-guard case) decided
 * NOT to retry. The consumer should treat the client object as terminal and
 * create a fresh one to reconnect after the user re-authenticates.
 *
 * NEVER fired in normal operation — receiving this callback means the
 * library cannot recover the session on its own.
 */
export type OnTerminalAuthFailure = () => void;
