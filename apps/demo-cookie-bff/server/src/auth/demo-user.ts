// The demo's ENRICHED app user (Decision #22).
//
// In cookie-BFF the session stores the consumer's OWN enriched user — not the
// raw id-token claims — and the library's cookie verifier attaches exactly
// this object to every WS procedure's `context.user`, and `/auth/me` echoes
// it. This demo enriches the id-token claims with a fixed `role` to prove the
// "enriched user lives in the session" point; a real app would look up the DB
// row (id, role, plan, …) in `resolveUser`.

export interface DemoUser {
  /** Keycloak subject — the session/connection key. */
  sub: string;
  email?: string;
  name?: string;
  /**
   * A field the id_token does NOT carry — added by `resolveUser` to prove the
   * verifier attaches the consumer's enriched user, not just raw claims. A
   * real app would resolve this from its own user store.
   */
  role: "demo-user";
}
