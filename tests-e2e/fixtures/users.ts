// Known users that exist in the imported realm
// (`setup/keycloak/orpc-ws-demo-realm.json`). Tests should reference
// these via the typed constant rather than hardcoding strings — when
// the realm seed grows new users, the type updates automatically.

export const KNOWN_TEST_USERS = {
  free: {
    username: "test@example.com",
    password: "test123",
    email: "test@example.com",
    firstName: "Test",
    lastName: "User",
  },
} as const;

export type KnownTestUser = (typeof KNOWN_TEST_USERS)["free"];
