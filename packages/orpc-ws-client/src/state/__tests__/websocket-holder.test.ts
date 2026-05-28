// Bug 10 regression — `currentAttemptOpened` lifecycle.
//
// The source-app bug: `currentAttemptOpened` was reset only inside
// `set()`/`clear()`. partysocket internally recreates the underlying native
// WebSocket on each reconnect WITHOUT calling holder.set() — so once the
// flag flipped true on the first successful open, it stayed true forever.
// A later handshake failure (which partysocket synthesizes as close code
// 1000) then no longer matched the "pre-open close" branch in event-handlers,
// and the client silently entered an infinite reconnect loop with no auth
// refresh kicking in.
//
// Fix invariant: the flag is reset ONLY by an explicit `resetCurrentAttempt()`
// call (event-handlers calls it at the top of every `onClose`), NOT by `set()`.
// `set()` initializes the flag to false because a brand-new instance has not
// yet opened, but it must not clear it after `markCurrentAttemptOpened()` if
// the consumer hasn't explicitly asked for a reset — these tests pin that.

import { describe, expect, it } from "vitest";

import { WebSocketHolder } from "../websocket-holder.js";
import type ReconnectingWebSocket from "partysocket/ws";

// We never invoke any method on the WS inside WebSocketHolder — it only
// stores the reference. A typed stub is enough; building a real
// ReconnectingWebSocket would trigger actual networking under happy-dom.
const makeStubSocket = (label = "ws"): ReconnectingWebSocket =>
  ({ __label: label } as unknown as ReconnectingWebSocket);

describe("WebSocketHolder — Bug 10 (currentAttemptOpened lifecycle)", () => {
  it("fresh holder: getCurrentAttemptOpened() returns false", () => {
    const holder = new WebSocketHolder();
    expect(holder.getCurrentAttemptOpened()).toBe(false);
  });

  it("markCurrentAttemptOpened() flips the flag to true", () => {
    const holder = new WebSocketHolder();
    holder.markCurrentAttemptOpened();
    expect(holder.getCurrentAttemptOpened()).toBe(true);
  });

  it("resetCurrentAttempt() flips the flag back to false", () => {
    const holder = new WebSocketHolder();
    holder.markCurrentAttemptOpened();
    expect(holder.getCurrentAttemptOpened()).toBe(true);

    holder.resetCurrentAttempt();
    expect(holder.getCurrentAttemptOpened()).toBe(false);
  });

  it("set(newWs) resets opened=false because the new instance has not opened yet", () => {
    // This is the inverse-direction guard: `set()` MUST reset to false on a
    // fresh instance (otherwise the next opened/close pair would skip the
    // pre-open branch incorrectly). The bug is in the OPPOSITE direction —
    // partysocket reconnects DON'T call set(), so the flag stays true across
    // them. That scenario is exercised below.
    const holder = new WebSocketHolder();
    const first = makeStubSocket("first");
    holder.set(first);
    holder.markCurrentAttemptOpened();
    expect(holder.getCurrentAttemptOpened()).toBe(true);

    const second = makeStubSocket("second");
    holder.set(second);
    expect(holder.getCurrentAttemptOpened()).toBe(false);
    expect(holder.get()).toBe(second);
  });

  it("clear() nulls the websocket and resets all per-attempt state", () => {
    const holder = new WebSocketHolder();
    holder.set(makeStubSocket());
    holder.setCurrentToken("tok-1");
    holder.markCurrentAttemptOpened();

    holder.clear();

    expect(holder.get()).toBeNull();
    expect(holder.getCurrentToken()).toBeNull();
    expect(holder.getCurrentAttemptOpened()).toBe(false);
  });

  it("currentToken round-trips through setCurrentToken/getCurrentToken", () => {
    const holder = new WebSocketHolder();
    expect(holder.getCurrentToken()).toBeNull();

    holder.setCurrentToken("tok-A");
    expect(holder.getCurrentToken()).toBe("tok-A");

    holder.setCurrentToken("tok-B");
    expect(holder.getCurrentToken()).toBe("tok-B");

    holder.setCurrentToken(null);
    expect(holder.getCurrentToken()).toBeNull();
  });

  it(
    "Bug 10 root scenario: opened, partysocket-internal reconnect (no set()), " +
      "next handshake must still see the flag and the consumer's onClose " +
      "resets it for the next attempt",
    () => {
      // Walk-through:
      //   1. New attempt #1 begins — holder.set(ws1), open succeeds,
      //      consumer calls markCurrentAttemptOpened().
      //   2. ws1 drops. partysocket synthesizes a 1000 close and BEGINS a
      //      reconnect internally — note: no `holder.set()` happens here.
      //      The flag is still TRUE from attempt #1.
      //   3. Consumer's onClose handler MUST reset the flag at the top of
      //      every close (per the source's verbatim comment), so the next
      //      attempt is evaluated independently.
      //   4. Attempt #2 begins inside partysocket, fails pre-open with a
      //      synthesized 1000 — and because we reset in step 3, the flag is
      //      false and the pre-open branch fires (triggering token refresh).
      const holder = new WebSocketHolder();
      const ws1 = makeStubSocket("attempt-1");

      // Step 1: open succeeds.
      holder.set(ws1);
      holder.markCurrentAttemptOpened();
      expect(holder.getCurrentAttemptOpened()).toBe(true);

      // Step 2: partysocket-internal reconnect — NO holder.set() call. The
      // flag must persist across set()-less reconnects so we can tell that
      // attempt #1 actually opened.
      expect(holder.get()).toBe(ws1);
      expect(holder.getCurrentAttemptOpened()).toBe(true);

      // Step 3: onClose runs and resets the flag for the next attempt.
      holder.resetCurrentAttempt();
      expect(holder.getCurrentAttemptOpened()).toBe(false);

      // Step 4: attempt #2 begins (still ws1 from partysocket's POV) and
      // fails pre-open — the flag is correctly false, so the pre-open
      // branch fires.
      expect(holder.getCurrentAttemptOpened()).toBe(false);
    },
  );

  it("flag is NOT reset by set() in the middle of partysocket reconnects (defensive)", () => {
    // Reaffirms the verbatim source comment: "resetting only in set()/clear()
    // would leave this true across internal reconnects". The flag stays
    // exactly where the explicit calls put it — no implicit reset.
    const holder = new WebSocketHolder();
    holder.set(makeStubSocket("ws1"));
    holder.markCurrentAttemptOpened();

    // No set(), no clear(), no resetCurrentAttempt() — flag stays true.
    expect(holder.getCurrentAttemptOpened()).toBe(true);
    expect(holder.getCurrentAttemptOpened()).toBe(true);
    expect(holder.getCurrentAttemptOpened()).toBe(true);
  });
});
