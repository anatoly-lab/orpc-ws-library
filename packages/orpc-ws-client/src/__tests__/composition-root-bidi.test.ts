// Composition-root bidi integration test.
//
// End-to-end-ish, mirroring `composition-root.test.ts`: the real
// `createOrpcWsClient` factory against a real `ws`-package WebSocketServer on an
// ephemeral loopback port. The stub server speaks NO ORPC — it accepts the
// connection and records the RAW bytes of the FIRST frame the client sends. That
// first frame is the stealth-heartbeat request (`link.call(HEARTBEAT_PATH, …)`
// fired from the per-open `onOpen` hook), which is exactly the frame we want to
// inspect for channel tagging.
//
// What this pins (the honest, no-server-peer slice — full server→client RPC
// round-trip is Phase-6 e2e):
//   - OPT-IN GATING: with NO `clientRouter`, the heartbeat frame is a RAW ORPC
//     frame (no channel tag) — proving no multiplexer is interposed and the
//     pre-bidi path is byte-identical.
//   - HEARTBEAT-STAYS-ON-C2S: with a `clientRouter`, the SAME heartbeat frame is
//     tagged for the c2s channel (leading unit `>`), never s2c (`<`) — proving
//     the mux is interposed AND heartbeat liveness rides c2s, unaffected by bidi.
//   - dispose() with bidi on tears down cleanly (terminal state, no throw).

import { os } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AddressInfo, createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";

import {
  BIDI_C2S_CHANNEL,
  BIDI_S2C_CHANNEL,
} from "@orpc-ws/shared";

import { createOrpcWsClient, type OrpcWsClient } from "../index.js";

type StubContract = Record<string, never>;

interface StubServerHandle {
  url: string;
  /** Leading byte of every frame the server received, in arrival order. */
  firstBytes: number[];
  closeAll: () => Promise<void>;
}

/**
 * Spin up a minimal HTTP + WebSocket server on a loopback ephemeral port. It
 * accepts every connection and records the leading byte of each inbound frame
 * (string OR binary — `ws` delivers both as a `Buffer`).
 */
async function spinUpStubServer(): Promise<StubServerHandle> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const firstBytes: number[] = [];
  const connections: WsWebSocket[] = [];

  wss.on("connection", (ws: WsWebSocket) => {
    connections.push(ws);
    ws.on("message", (data: Buffer) => {
      // `ws` hands string and binary frames alike as a Buffer; the leading byte
      // is the channel tag char-code when tagged (`>` = 0x3E / `<` = 0x3C).
      firstBytes.push(data[0] ?? 0);
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port}`;

  const closeAll = async () => {
    for (const ws of connections) {
      try {
        ws.close();
      } catch {
        // best-effort
      }
    }
    await new Promise<void>((resolve) => {
      wss.close(() => httpServer.close(() => resolve()));
    });
  };

  return { url, firstBytes, closeAll };
}

async function waitUntil(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const intervalMs = opts.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: predicate not satisfied within ${timeoutMs}ms`);
}

const C2S_BYTE = BIDI_C2S_CHANNEL.charCodeAt(0); // 0x3E ">"
const S2C_BYTE = BIDI_S2C_CHANNEL.charCodeAt(0); // 0x3C "<"

// The client's OWN router (callee) — a bare, context-free `os` router, so bidi
// turns on with no `clientContext` required.
const clientRouter = { ping: os.handler(() => "pong") };

describe("createOrpcWsClient composition root — bidi (server→client) integration", () => {
  let server: StubServerHandle;
  let client: OrpcWsClient<StubContract> | null = null;

  beforeEach(async () => {
    server = await spinUpStubServer();
  });

  afterEach(async () => {
    if (client) {
      try {
        client.dispose();
      } catch {
        // tolerated
      }
      client = null;
    }
    await server.closeAll();
  });

  it("bidi OFF — the heartbeat frame is a raw ORPC frame (no channel tag)", async () => {
    client = createOrpcWsClient<StubContract>({
      url: server.url,
      sleepDetection: false,
      // no clientRouter → bidi off
    });

    client.connect();
    await waitUntil(() => server.firstBytes.length >= 1);

    // The first frame the client sends (the heartbeat request) is NOT tagged —
    // no multiplexer sits in front of the c2s RPCLink.
    const tag = server.firstBytes[0];
    expect(tag).not.toBe(C2S_BYTE);
    expect(tag).not.toBe(S2C_BYTE);
  });

  it("bidi ON — the heartbeat frame is tagged for the c2s channel (never s2c)", async () => {
    client = createOrpcWsClient<StubContract, typeof clientRouter>({
      url: server.url,
      sleepDetection: false,
      clientRouter,
    });

    client.connect();
    await waitUntil(() => server.firstBytes.length >= 1);

    // The heartbeat request rides the c2s channel — the multiplexer is interposed
    // AND heartbeat liveness is unaffected by bidi. Never the s2c channel (that
    // carries server→client traffic, hosted by the clientRouter).
    expect(server.firstBytes[0]).toBe(C2S_BYTE);
    expect(server.firstBytes[0]).not.toBe(S2C_BYTE);
  });

  it("bidi ON — dispose() tears down cleanly (terminal state, no throw)", async () => {
    client = createOrpcWsClient<StubContract, typeof clientRouter>({
      url: server.url,
      sleepDetection: false,
      clientRouter,
    });

    client.connect();
    await waitUntil(() => server.firstBytes.length >= 1);

    expect(() => client!.dispose()).not.toThrow();

    const s = client.state.getState();
    expect(s.status).toBe("disconnected");
    if (s.status === "disconnected") {
      expect(s.willRetry).toBe(false);
    }
  });
});
