import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createTokenCipher } from "../token-cipher.js";

const KEY = randomBytes(32);
const KEY_B64 = KEY.toString("base64");

describe("token-cipher", () => {
  it("round-trips a single token (encrypt → decrypt)", () => {
    const cipher = createTokenCipher({ key: KEY });
    const plain = "an.access.token-value";
    const env = cipher.encrypt(plain);
    expect(env).not.toContain(plain); // ciphertext, not plaintext
    expect(cipher.decrypt(env)).toBe(plain);
  });

  it("emits a self-describing v1:<keyId>:… envelope", () => {
    const cipher = createTokenCipher({ key: KEY, keyId: "kc-2024" });
    const env = cipher.encrypt("x");
    const parts = env.split(":");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe("kc-2024");
  });

  it("uses a fresh IV per encryption (same plaintext → different ciphertext)", () => {
    const cipher = createTokenCipher({ key: KEY });
    expect(cipher.encrypt("same")).not.toBe(cipher.encrypt("same"));
  });

  it("accepts a base64 string key equivalently to raw bytes", () => {
    const a = createTokenCipher({ key: KEY });
    const b = createTokenCipher({ key: KEY_B64 });
    // b can decrypt what a encrypted (same key material, default keyId).
    expect(b.decrypt(a.encrypt("shared"))).toBe("shared");
  });

  it("decrypts an old session under a rotated key via previousKeys", () => {
    const oldKey = randomBytes(32);
    // Session encrypted under the old key (keyId "k0" default).
    const oldCipher = createTokenCipher({ key: oldKey, keyId: "old" });
    const env = oldCipher.encrypt("legacy-token");

    // After rotation: new primary key, old key kept for the grace window.
    const rotated = createTokenCipher({
      key: KEY,
      keyId: "new",
      previousKeys: { old: oldKey },
    });
    expect(rotated.decrypt(env)).toBe("legacy-token");
    // New encryptions use the new keyId.
    expect(rotated.encrypt("fresh").split(":")[1]).toBe("new");
  });

  it("throws when the named key is unavailable", () => {
    const c1 = createTokenCipher({ key: randomBytes(32), keyId: "gone" });
    const env = c1.encrypt("x");
    const c2 = createTokenCipher({ key: KEY, keyId: "current" });
    expect(() => c2.decrypt(env)).toThrow(/No decryption key for keyId/);
  });

  it("throws on a key of the wrong length (bytes)", () => {
    expect(() => createTokenCipher({ key: randomBytes(16) })).toThrow(
      /must be 32 bytes/,
    );
  });

  it("throws on a base64 key that decodes to the wrong length", () => {
    expect(() =>
      createTokenCipher({ key: randomBytes(20).toString("base64") }),
    ).toThrow(/must be 32 bytes/);
  });

  it("throws when a keyId contains the ':' separator", () => {
    expect(() => createTokenCipher({ key: KEY, keyId: "a:b" })).toThrow(/':'/);
  });

  it("fails authentication when the ciphertext is tampered", () => {
    const cipher = createTokenCipher({ key: KEY });
    const env = cipher.encrypt("tamper-me");
    const parts = env.split(":");
    // Flip a byte in the ciphertext payload.
    const data = Buffer.from(parts[4]!, "base64url");
    data[0] = data[0]! ^ 0xff;
    parts[4] = data.toString("base64url");
    expect(() => cipher.decrypt(parts.join(":"))).toThrow();
  });

  it("fails authentication when the auth tag is tampered", () => {
    const cipher = createTokenCipher({ key: KEY });
    const env = cipher.encrypt("tag-tamper");
    const parts = env.split(":");
    const tag = Buffer.from(parts[3]!, "base64url");
    tag[0] = tag[0]! ^ 0xff;
    parts[3] = tag.toString("base64url");
    expect(() => cipher.decrypt(parts.join(":"))).toThrow();
  });

  it("rejects a malformed envelope (wrong field count / version)", () => {
    const cipher = createTokenCipher({ key: KEY });
    expect(() => cipher.decrypt("v1:only:three")).toThrow(/Malformed/);
    expect(() => cipher.decrypt("v9:k0:a:b:c")).toThrow(/Unsupported/);
  });

  it("round-trips a token-set and preserves nulls", () => {
    const cipher = createTokenCipher({ key: KEY });
    const enc = cipher.encryptTokenSet({
      accessToken: "acc",
      refreshToken: null,
      idToken: "id",
    });
    expect(enc.refreshToken).toBeNull();
    expect(enc.accessToken).not.toBe("acc");
    const back = cipher.decryptTokenSet(enc);
    expect(back).toEqual({
      accessToken: "acc",
      refreshToken: null,
      idToken: "id",
    });
  });
});
