import { describe, expect, it } from "vitest";

import { clearCookie, parseCookie, serializeCookie } from "../serialize.js";

describe("serializeCookie", () => {
  it("applies hardened defaults (Strict, Secure, HttpOnly, Path=/)", () => {
    const c = serializeCookie("sid", "abc");
    expect(c).toContain("sid=abc");
    expect(c).toContain("Path=/");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
  });

  it("includes Max-Age when given", () => {
    expect(serializeCookie("sid", "x", { maxAge: 100 })).toContain("Max-Age=100");
  });

  it("can disable Secure / HttpOnly and switch to Lax (localhost demo)", () => {
    const c = serializeCookie("sid", "x", {
      secure: false,
      httpOnly: false,
      sameSite: "lax",
    });
    expect(c).not.toContain("Secure");
    expect(c).not.toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
  });

  it("emits a Domain attribute when given (non-hostPrefix)", () => {
    expect(serializeCookie("c", "v", { domain: "example.com" })).toContain(
      "Domain=example.com",
    );
  });

  describe("__Host- invariants", () => {
    it("forces Secure and Path=/ even if overridden", () => {
      const c = serializeCookie("__Host-sid", "x", {
        hostPrefix: true,
        secure: false,
        path: "/sub",
      });
      expect(c).toContain("Secure");
      expect(c).toContain("Path=/");
      expect(c).not.toContain("Path=/sub");
    });

    it("throws when a Domain is supplied with hostPrefix", () => {
      expect(() =>
        serializeCookie("__Host-sid", "x", {
          hostPrefix: true,
          domain: "example.com",
        }),
      ).toThrow(/host-only/);
    });

    it("never emits Domain under hostPrefix", () => {
      const c = serializeCookie("__Host-sid", "x", { hostPrefix: true });
      expect(c).not.toContain("Domain=");
    });
  });

  it("percent-encodes the value and round-trips losslessly through parseCookie", () => {
    const value = "a b;c=d%e";
    const header = serializeCookie("k", value).split(";")[0]!; // "k=<encoded>"
    expect(header).toContain("%"); // encoded
    expect(parseCookie(header, "k")).toBe(value);
  });
});

describe("parseCookie", () => {
  it("returns null for an absent header or missing cookie", () => {
    expect(parseCookie(undefined, "k")).toBeNull();
    expect(parseCookie("a=1; b=2", "k")).toBeNull();
  });

  it("reads one named cookie from a multi-pair header", () => {
    expect(parseCookie("a=1; sid=xyz; b=2", "sid")).toBe("xyz");
  });

  it("falls back to the raw value on malformed percent-encoding", () => {
    expect(parseCookie("k=%E0%A4%A", "k")).toBe("%E0%A4%A");
  });
});

describe("clearCookie", () => {
  it("emits Max-Age=0 with an empty value", () => {
    const c = clearCookie("sid");
    expect(c).toContain("sid=");
    expect(c).toContain("Max-Age=0");
  });

  it("honors hostPrefix invariants when clearing", () => {
    const c = clearCookie("__Host-sid", { hostPrefix: true });
    expect(c).toContain("Secure");
    expect(c).toContain("Path=/");
  });
});
