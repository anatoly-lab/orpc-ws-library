// `CookieBffAuthController` — pure translator: it maps the core's
// `AuthInstruction` to express `res` calls. We feed a fake core (returns
// scripted instructions) + a fake express `res` recording the calls, and
// assert status / Set-Cookie append / redirect-vs-json.

import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import type { AuthInstruction, CookieBffCore } from "@orpc-ws/cookie-bff";

import { CookieBffAuthController } from "../auth.controller.js";

/** A fake express response recording every call the translator makes. */
function fakeRes() {
  const calls = {
    status: undefined as number | undefined,
    setCookies: [] as string[],
    redirect: undefined as { status: number; url: string } | undefined,
    json: undefined as unknown,
    ended: false,
  };
  const res = {
    status(code: number) {
      calls.status = code;
      return res;
    },
    append(name: string, value: string) {
      if (name === "Set-Cookie") calls.setCookies.push(value);
      return res;
    },
    redirect(status: number, url: string) {
      calls.redirect = { status, url };
    },
    json(body: unknown) {
      calls.json = body;
    },
    end() {
      calls.ended = true;
    },
  } as unknown as Response;
  return { res, calls };
}

const fakeReq = (cookie?: string): Request =>
  ({ headers: cookie ? { cookie } : {}, query: {} }) as Request;

/** Build a controller whose core returns the given instruction from `method`. */
function controllerReturning(
  method: keyof CookieBffCore,
  instruction: AuthInstruction,
) {
  const core = {
    login: vi.fn(),
    callback: vi.fn(),
    me: vi.fn(),
    logout: vi.fn(),
  } as unknown as CookieBffCore;
  (core[method] as ReturnType<typeof vi.fn>).mockResolvedValue(instruction);
  return new CookieBffAuthController(core);
}

describe("CookieBffAuthController translation", () => {
  it("login: applies status + Set-Cookie(s) + redirect", async () => {
    const ctrl = controllerReturning("login", {
      status: 302,
      redirect: "https://idp.example/authorize?x=1",
      setCookies: [{ value: "oauth_state=abc; HttpOnly" }],
    });
    const { res, calls } = fakeRes();
    await ctrl.login(fakeReq(), res);

    expect(calls.status).toBe(302);
    expect(calls.setCookies).toEqual(["oauth_state=abc; HttpOnly"]);
    expect(calls.redirect).toEqual({
      status: 302,
      url: "https://idp.example/authorize?x=1",
    });
    expect(calls.json).toBeUndefined();
  });

  it("appends BOTH setCookies and setClearCookies then redirects (multi-Set-Cookie path)", async () => {
    // Two setCookies + a clear — exercises that every cookie is `append`ed so
    // they coexist. (Generic cookie values; the translator is cookie-agnostic.)
    const ctrl = controllerReturning("callback", {
      status: 302,
      redirect: "https://web.example",
      setCookies: [{ value: "__Host-sid=s" }, { value: "other=v" }],
      setClearCookies: [{ value: "oauth_state=; Max-Age=0" }],
    });
    const { res, calls } = fakeRes();
    await ctrl.callback(fakeReq(), res);

    expect(calls.status).toBe(302);
    expect(calls.setCookies).toEqual([
      "__Host-sid=s",
      "other=v",
      "oauth_state=; Max-Age=0",
    ]);
    expect(calls.redirect?.url).toBe("https://web.example");
  });

  it("me: sends the { user, csrfToken } JSON body, no Set-Cookie", async () => {
    const ctrl = controllerReturning("me", {
      status: 200,
      body: { user: { id: "db-1" }, csrfToken: "tok-1" },
    });
    const { res, calls } = fakeRes();
    await ctrl.me(fakeReq("__Host-sid=s"), res);

    expect(calls.status).toBe(200);
    expect(calls.setCookies).toEqual([]); // /me sets no cookie now
    expect(calls.json).toEqual({ user: { id: "db-1" }, csrfToken: "tok-1" });
    expect(calls.redirect).toBeUndefined();
  });

  it("me 401: status + json error, no cookies", async () => {
    const ctrl = controllerReturning("me", {
      status: 401,
      body: { error: "Not authenticated" },
    });
    const { res, calls } = fakeRes();
    await ctrl.me(fakeReq(), res);
    expect(calls.status).toBe(401);
    expect(calls.json).toEqual({ error: "Not authenticated" });
    expect(calls.setCookies).toEqual([]);
  });

  it("logout: clears the sid cookie and returns the body", async () => {
    const ctrl = controllerReturning("logout", {
      status: 200,
      setClearCookies: [{ value: "__Host-sid=; Max-Age=0" }],
      body: { ok: true, endSessionUrl: "https://idp.example/logout" },
    });
    const { res, calls } = fakeRes();
    await ctrl.logout(fakeReq(), res);

    expect(calls.status).toBe(200);
    expect(calls.setCookies).toEqual(["__Host-sid=; Max-Age=0"]);
    expect(calls.json).toMatchObject({ ok: true });
  });

  it("ends the response when there is neither redirect nor body", async () => {
    const ctrl = controllerReturning("login", { status: 204 });
    const { res, calls } = fakeRes();
    await ctrl.login(fakeReq(), res);
    expect(calls.status).toBe(204);
    expect(calls.ended).toBe(true);
  });
});
