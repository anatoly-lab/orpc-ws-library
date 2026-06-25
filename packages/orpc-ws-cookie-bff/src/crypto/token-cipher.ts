// At-rest token encryption seam (§E.3, Decision #22).
//
// The Keycloak access / refresh / id tokens are encrypted with AES-256-GCM
// before they hit the `SessionStore`, and decrypted only in library memory
// when actually needed (a lazy refresh, RP-initiated logout). A compromised
// store — a leaked KV dump, a stolen DB — must not yield usable tokens. The
// `sid` itself stays plaintext: it is the lookup key and is already opaque.
//
// CIPHERTEXT ENVELOPE (self-describing, so decrypt needs no out-of-band
// metadata):
//
//   v1:<keyId>:<base64url(iv)>:<base64url(authTag)>:<base64url(ciphertext)>
//
//   - `v1`       — envelope version, so the format can evolve.
//   - `<keyId>`  — which key encrypted this. KEY ROTATION: construct the
//                  cipher with a primary key + a map of old keys by id; an
//                  old session encrypted under a retired key still decrypts
//                  during the grace window because its envelope names the key.
//   - `<iv>`     — 12-byte GCM IV, fresh per encryption (CSPRNG).
//   - `<authTag>`— 16-byte GCM authentication tag; tamper → decrypt throws.
//   - ciphertext — the encrypted token bytes.
//
// base64url (no `+`/`/`/`=`) is used for the parts so the envelope never
// collides with the `:` separator. `randomBytes` is the CSPRNG security
// primitive (not the deterministic `Rng` test seam), so it is used directly.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256 requires a 32-byte key. */
const KEY_BYTES = 32;
/** GCM's recommended IV length is 96 bits (12 bytes). */
const IV_BYTES = 12;
/** GCM authentication-tag length, bytes. */
const AUTH_TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = "v1";
/** Default id for the primary key when the consumer doesn't name one. */
const DEFAULT_KEY_ID = "k0";

/** A raw 32-byte key as accepted from the consumer: bytes or base64 string. */
export type CipherKeyInput = Buffer | string;

/** Options for {@link createTokenCipher}. */
export interface TokenCipherOptions {
  /** The primary (current) encryption key — 32 raw bytes or base64. */
  key: CipherKeyInput;
  /**
   * Stable id for the primary key, embedded in every new ciphertext so a
   * rotated key can still decrypt it later. Defaults to `"k0"`. Must not
   * contain `:` (the envelope separator).
   */
  keyId?: string;
  /**
   * Retired keys kept for the rotation grace window, by their id. When a
   * ciphertext names one of these ids, decrypt uses it; encrypt NEVER uses
   * them (new sessions always use the primary key). Each value is 32 raw
   * bytes or base64.
   */
  previousKeys?: Record<string, CipherKeyInput>;
}

/** The three Keycloak tokens, plaintext (as received from the IdP). */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
}

/** The encrypted token-set, matching `SessionData["enc"]`. */
export interface EncryptedTokenSet {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
}

/**
 * The at-rest cipher. Encrypts/decrypts single token strings and whole
 * token-sets. Construct once (per process) from the consumer's key(s).
 */
export interface TokenCipher {
  /** Encrypt one plaintext token into a `v1:…` envelope string. */
  encrypt(plaintext: string): string;
  /** Decrypt a `v1:…` envelope back to plaintext. Throws on tamper / bad key. */
  decrypt(envelope: string): string;
  /** Encrypt a whole token-set, preserving `null` for absent refresh/id tokens. */
  encryptTokenSet(tokens: TokenSet): EncryptedTokenSet;
  /** Decrypt a whole token-set, preserving `null`s. */
  decryptTokenSet(enc: EncryptedTokenSet): TokenSet;
}

/**
 * Coerce a consumer key input to a validated 32-byte Buffer.
 *
 * Accepts 32 raw bytes (a `Buffer`) or a base64 string that decodes to 32
 * bytes. Throws a clear error on any other length so a misconfigured key is a
 * loud startup failure, not a silent weak-crypto bug.
 */
function coerceKey(input: CipherKeyInput, label: string): Buffer {
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `${label}: AES-256 key must be ${KEY_BYTES} bytes ` +
        `(got ${buf.length}). Provide 32 raw bytes or a base64 string ` +
        `that decodes to 32 bytes.`,
    );
  }
  return buf;
}

/**
 * Build the {@link TokenCipher}. Validates every key up front (length check)
 * so a bad key fails at construction, not at first encrypt.
 */
export function createTokenCipher(opts: TokenCipherOptions): TokenCipher {
  const primaryKeyId = opts.keyId ?? DEFAULT_KEY_ID;
  if (primaryKeyId.includes(":")) {
    throw new Error(`keyId must not contain ':' (got "${primaryKeyId}").`);
  }

  // All decryptable keys by id (primary + retired), validated to 32 bytes.
  const keysById = new Map<string, Buffer>();
  keysById.set(primaryKeyId, coerceKey(opts.key, "encryptionKey"));
  for (const [id, value] of Object.entries(opts.previousKeys ?? {})) {
    if (id.includes(":")) {
      throw new Error(`previous keyId must not contain ':' (got "${id}").`);
    }
    if (!keysById.has(id)) {
      keysById.set(id, coerceKey(value, `previousKeys["${id}"]`));
    }
  }
  const primaryKey = keysById.get(primaryKeyId)!;

  const toB64Url = (b: Buffer): string => b.toString("base64url");

  function encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, primaryKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
      ENVELOPE_VERSION,
      primaryKeyId,
      toB64Url(iv),
      toB64Url(authTag),
      toB64Url(ciphertext),
    ].join(":");
  }

  function decrypt(envelope: string): string {
    const parts = envelope.split(":");
    if (parts.length !== 5) {
      throw new Error("Malformed ciphertext envelope: expected 5 fields.");
    }
    const [version, keyId, ivB64, tagB64, dataB64] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (version !== ENVELOPE_VERSION) {
      throw new Error(`Unsupported ciphertext version "${version}".`);
    }
    const key = keysById.get(keyId);
    if (!key) {
      throw new Error(
        `No decryption key for keyId "${keyId}" ` +
          `(rotated out, or wrong cipher config).`,
      );
    }
    const iv = Buffer.from(ivB64, "base64url");
    const authTag = Buffer.from(tagB64, "base64url");
    if (authTag.length !== AUTH_TAG_BYTES) {
      throw new Error("Malformed ciphertext: bad auth-tag length.");
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    // `final()` throws if the GCM tag doesn't verify — i.e. on tamper or
    // wrong key. We let that propagate; the caller treats a decrypt failure
    // as an unusable session.
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }

  return {
    encrypt,
    decrypt,
    encryptTokenSet(tokens) {
      return {
        accessToken: encrypt(tokens.accessToken),
        refreshToken:
          tokens.refreshToken === null ? null : encrypt(tokens.refreshToken),
        idToken: tokens.idToken === null ? null : encrypt(tokens.idToken),
      };
    },
    decryptTokenSet(enc) {
      return {
        accessToken: decrypt(enc.accessToken),
        refreshToken:
          enc.refreshToken === null ? null : decrypt(enc.refreshToken),
        idToken: enc.idToken === null ? null : decrypt(enc.idToken),
      };
    },
  };
}
