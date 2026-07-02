---
"@orpc-ws/client": patch
---

Fix a critical reconnect bug cluster around `swapSocket`'s synchronous close (Bugs 21–24):

- `swapSocket` now follows the CLEAR-BEFORE-CLOSE discipline. partysocket ≥1.2 dispatches `close()` synchronously, so the old wrapper's synthetic pre-open close-1000 was processed as a real close → auth-recovery → storm-guard trip → spurious terminal logout after a *successful* token refresh (cookie mode: force-logout on a routine sleep-wake).
- `swapSocket` re-checks `isDead()` after the close so a terminal fired mid-swap can no longer resurrect a zombie socket that flips state back to `connected`.
- A pre-open close 1000 carrying partysocket's connection-timeout reason (`"timeout"`) is now classified as a normal retryable disconnect instead of an auth failure.
- The auth-recovery decision carries its provenance (`"auth-close"` vs `"pre-open-1000"`); with no `tokenProvider` (cookie auth), a pre-open network failure is now a benign no-op — only a real auth-failure close (1008/4001) goes terminal, restoring the documented cookie-auth contract.
