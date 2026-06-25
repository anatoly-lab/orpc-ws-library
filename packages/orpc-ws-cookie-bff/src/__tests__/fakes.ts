// Shared deterministic fakes for the cookie-bff core tests.
//
// A fake session store (Map-backed), a fake clock, and a fake Fetcher that
// scripts discovery + token-endpoint responses. No real network, no real
// timers — every collaborator is injected (CLAUDE.md "Tests from day 0").

import type { Clock, TimerHandle } from "@orpc-ws/shared";

import type { Fetcher } from "../oidc/discovery.js";
import type { SessionData, SessionStore } from "../session-store.js";

/** A clock fixed at a settable instant. */
export function fakeClock(start = 1_700_000_000_000): Clock & {
  set(t: number): void;
  advance(ms: number): void;
} {
  let t = start;
  const noopHandle = {} as TimerHandle;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (ms: number) => {
      t += ms;
    },
    setTimeout: () => noopHandle,
    clearTimeout: () => {},
    setInterval: () => noopHandle,
    clearInterval: () => {},
  };
}

/** Map-backed `SessionStore` recording calls; can be made to throw on `get`. */
export class FakeSessionStore<TUser> implements SessionStore<TUser> {
  readonly map = new Map<string, SessionData<TUser>>();
  readonly setCalls: Array<{ sid: string; ttlSeconds: number }> = [];
  readonly deletedByUser: string[] = [];
  throwOnGet = false;

  async set(
    sid: string,
    data: SessionData<TUser>,
    opts: { ttlSeconds: number },
  ): Promise<void> {
    this.setCalls.push({ sid, ttlSeconds: opts.ttlSeconds });
    this.map.set(sid, data);
  }
  async get(sid: string): Promise<SessionData<TUser> | null> {
    if (this.throwOnGet) throw new Error("store down");
    return this.map.get(sid) ?? null;
  }
  async delete(sid: string): Promise<void> {
    this.map.delete(sid);
  }
  async deleteByUser(sub: string): Promise<void> {
    this.deletedByUser.push(sub);
    for (const [sid, data] of this.map) {
      if (data.sub === sub) this.map.delete(sid);
    }
  }
}

/** One scripted HTTP response. */
interface FakeResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  json?: unknown;
  text?: string;
}

/**
 * A `Fetcher` that returns scripted responses by URL substring match, and
 * records every call. `tokenResponses` is a queue consumed in order for the
 * token endpoint (so repeated refreshes can return different bodies).
 */
export function fakeFetcher(opts: {
  discovery?: FakeResponse;
  token?: FakeResponse;
  tokenQueue?: FakeResponse[];
}): Fetcher & { calls: Array<{ url: string; body?: string }> } {
  const calls: Array<{ url: string; body?: string }> = [];
  const tokenQueue = opts.tokenQueue ? [...opts.tokenQueue] : null;

  const fetcher = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, ...(init?.body ? { body: init.body } : {}) });
    const pick = (r: FakeResponse | undefined): FakeResponse =>
      r ?? { ok: false, status: 500, statusText: "no fake", text: "" };

    let resp: FakeResponse;
    if (url.includes(".well-known")) {
      resp = pick(
        opts.discovery ?? {
          ok: true,
          status: 200,
          json: {
            authorization_endpoint: "https://idp.example/authorize",
            token_endpoint: "https://idp.example/token",
            end_session_endpoint: "https://idp.example/logout",
          },
        },
      );
    } else {
      resp = tokenQueue?.length ? tokenQueue.shift()! : pick(opts.token);
    }

    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText ?? "",
      text: async () => resp.text ?? "",
      json: async () => resp.json ?? {},
    };
  }) as Fetcher & { calls: typeof calls };
  fetcher.calls = calls;
  return fetcher;
}

/** Build an unsigned JWT with the given payload (for id-token claim tests). */
export function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}
