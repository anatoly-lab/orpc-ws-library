// Bug 24 regression — cookie auth (no tokenProvider): a pre-open network
// failure must NOT force-log-out the user.
//
// The locked contract (CLAUDE.md §"Auth flow contract", "Cookie-auth
// caveat"): with no `tokenProvider`, ONLY an actual auth-failure close
// (1008 / 4001) goes terminal. But the composition root's
// `onAuthRecoveryNeeded` branch fired `fireTerminalAuthFailure()` for
// EVERY auth-recovery trigger — including the Bug-4 pre-open code-1000
// shape, which partysocket synthesizes for EVERY pre-open failure
// (connection refused, DNS, TLS, server restart). Net effect: a cookie-auth
// client whose server was briefly unreachable went TERMINAL — session
// intact, cookie valid, user "logged out" by a network blip.
//
// Fix under test (composition level, real partysocket): the close-decision
// now tags auth-recovery with its provenance (`"auth-close"` vs
// `"pre-open-1000"`), and the no-tokenProvider branch treats
// `"pre-open-1000"` as a benign no-op — partysocket keeps retrying on its
// own backoff. A REAL auth close (1008) with no tokenProvider still goes
// terminal (the contract's other arm — pinned here so the fix can't
// over-reach).

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";

import {
  createOrpcWsClient,
  type ClientEvent,
  type OrpcWsClient,
} from "../index.js";

type StubContract = Record<string, never>;

/**
 * Reserve a loopback port with NO listener: bind on port 0, read the port,
 * close the server. Connecting there is refused — the browser/undici layer
 * errors pre-open and partysocket synthesizes the code-1000 close this
 * regression needs.
 */
async function reserveClosedPort(): Promise<number> {
  const srv: Server = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** WS server that accepts the handshake then closes 1008 (auth reject). */
async function spinUpRejectingServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws: WsWebSocket) => {
    ws.close(1008, "Auth rejected");
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}

async function waitUntil(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: predicate not satisfied within ${timeoutMs}ms`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tight retry knobs: within the grace window below, partysocket visibly
 * cycles several pre-open failures — pre-fix, the FIRST of them already
 * fired terminal, so the window is generous for the regression.
 */
const FAST_RETRY = {
  minReconnectionDelay: 20,
  maxReconnectionDelay: 40,
  reconnectionDelayGrowFactor: 1,
  connectionTimeout: 500,
};

describe("Bug 24 — cookie auth: pre-open-1000 is benign, real auth close is terminal", () => {
  let client: OrpcWsClient<StubContract> | null = null;

  afterEach(() => {
    if (client) {
      try {
        client.dispose();
      } catch {
        // tolerated
      }
      client = null;
    }
  });

  it(
    "no tokenProvider + unreachable server (pre-open close-1000 loop): " +
      "no terminal, no onTerminalAuthFailure, no events; keeps retrying",
    async () => {
      const port = await reserveClosedPort();
      const onTerminalAuthFailure = vi.fn();
      const events: ClientEvent[] = [];

      client = createOrpcWsClient<StubContract>({
        url: `ws://127.0.0.1:${port}`,
        // tokenProvider intentionally omitted — cookie-auth path. There is
        // nothing to refresh; the session cookie is untouched by a network
        // blip, so the library must ride partysocket's retry loop.
        onTerminalAuthFailure,
        onEvent: (evt) => events.push(evt),
        reconnect: FAST_RETRY,
        sleepDetection: false,
      });

      client.connect();

      // Grace window covering many refused-connection retries (each one a
      // synthetic pre-open close-1000). Pre-fix, the FIRST retry's close
      // already fired terminal.
      await sleep(300);

      expect(onTerminalAuthFailure).not.toHaveBeenCalled();
      // Benign means SILENT: no auth_failure notification of either kind.
      expect(events.filter((e) => e.type === "auth_failure")).toEqual([]);
      // Non-terminal disconnected — the library still intends to retry
      // (partysocket's loop is alive; pre-fix this was willRetry: false).
      //
      // The close CODE is deliberately not pinned to 1000: a refused
      // connection races partysocket's error-driven synthetic close (1000)
      // against the native close event (1006), and which one wins is
      // environment-dependent. Both are benign pre-open shapes (1006 never
      // routed to auth-recovery; 1000 is the arm this regression guards),
      // and across the many retries in the grace window the synthetic-1000
      // attempts are what would have fired terminal pre-fix. The
      // classification itself is pinned deterministically at the decision
      // level (bug-23 + event-handlers tests).
      const state = client.state.getState();
      expect(state).toMatchObject({
        status: "disconnected",
        willRetry: true,
      });
      expect(
        state.status === "disconnected" ? state.code : undefined,
      ).toBeOneOf([1000, 1006]);
    },
  );

  it(
    "no tokenProvider + REAL auth close (1008): still terminal " +
      "(the contract's other arm — the fix must not over-reach)",
    async () => {
      const server = await spinUpRejectingServer();
      try {
        const onTerminalAuthFailure = vi.fn();

        client = createOrpcWsClient<StubContract>({
          url: server.url,
          // tokenProvider intentionally omitted — a server-signalled auth
          // reject with nothing to refresh IS terminal.
          onTerminalAuthFailure,
          reconnect: FAST_RETRY,
          sleepDetection: false,
        });

        client.connect();
        await waitUntil(() => onTerminalAuthFailure.mock.calls.length >= 1);

        expect(onTerminalAuthFailure).toHaveBeenCalledTimes(1);
        expect(client.state.getState()).toEqual({
          status: "disconnected",
          willRetry: false,
        });
      } finally {
        await server.close();
      }
    },
  );
});
