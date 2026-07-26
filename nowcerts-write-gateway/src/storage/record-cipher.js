// Encryption at rest for intake bundles and write proposals.
//
// These records carry regulated PII — client identity, contacts, and (once the
// contact write path is enabled) date of birth, driver's license number, and
// SSN. Georgia breach-notification and GLBA safeguards both attach to that data,
// so it must not sit on disk as plaintext JSON.
//
// AES-256-GCM with a random 12-byte IV per write. GCM is authenticated: a
// tampered ciphertext fails to decrypt rather than yielding altered records.
//
// Key: 32 bytes, supplied as hex or base64 via GATEWAY_ENCRYPTION_KEY_FILE
// (preferred — a 600-perm file mounted like the other secrets) or
// GATEWAY_ENCRYPTION_KEY. When neither is set the cipher is inert and records
// are written as plaintext, which keeps local/offline development working
// exactly as before.
//
// Reads are backward compatible in one direction only: an encrypted envelope is
// recognized by its shape, and anything else is parsed as plaintext JSON. That
// lets an existing deployment turn encryption on without migrating the files
// already on disk — they stay readable, and each rewrite upgrades them.

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const ENVELOPE_VERSION = 1;

export function parseKey(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  // Accept hex or base64 so the key can be generated with either
  // `openssl rand -hex 32` or `openssl rand -base64 32`.
  const candidate = /^[0-9a-f]{64}$/i.test(text)
    ? Buffer.from(text, "hex")
    : Buffer.from(text, "base64");
  if (candidate.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must be ${KEY_BYTES} bytes (64 hex chars or 44 base64 chars); got ${candidate.length}.`,
    );
  }
  return candidate;
}

export class RecordCipher {
  #key;

  constructor(key = null) {
    this.#key = key;
  }

  get enabled() {
    return this.#key !== null;
  }

  // Null key => passthrough. Callers stay identical whether or not a key exists.
  static fromEnv(env = process.env) {
    const file = env.GATEWAY_ENCRYPTION_KEY_FILE;
    if (file) return new RecordCipher(parseKey(readFileSync(file, "utf8")));
    if (env.GATEWAY_ENCRYPTION_KEY) return new RecordCipher(parseKey(env.GATEWAY_ENCRYPTION_KEY));
    return new RecordCipher(null);
  }

  // Serialize a record to the bytes that land on disk.
  serialize(record) {
    const json = `${JSON.stringify(record, null, 2)}\n`;
    if (!this.enabled) return json;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
    return `${JSON.stringify({
      v: ENVELOPE_VERSION,
      alg: ALGORITHM,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: ciphertext.toString("base64"),
    })}\n`;
  }

  // Inverse of serialize(). Plaintext records written before encryption was
  // turned on still parse, so enabling a key does not orphan existing data.
  deserialize(text) {
    const parsed = JSON.parse(text);
    if (!isEnvelope(parsed)) return parsed;
    if (!this.enabled) {
      throw new Error(
        "This record is encrypted but no encryption key is configured. Set GATEWAY_ENCRYPTION_KEY_FILE.",
      );
    }
    if (parsed.alg !== ALGORITHM) {
      throw new Error(`Unsupported record encryption algorithm: ${parsed.alg}.`);
    }
    const decipher = createDecipheriv(ALGORITHM, this.#key, Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    let plaintext;
    try {
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // GCM tag mismatch: wrong key, or the file was modified underneath us.
      throw new Error("Record failed decryption — wrong key or the stored record was tampered with.");
    }
    return JSON.parse(plaintext);
  }

  // Used by tests and any future key-rotation tooling.
  matches(otherKey) {
    if (!this.enabled || !otherKey) return false;
    return this.#key.length === otherKey.length && timingSafeEqual(this.#key, otherKey);
  }
}

export function isEnvelope(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.v === ENVELOPE_VERSION &&
    typeof value.alg === "string" &&
    typeof value.iv === "string" &&
    typeof value.tag === "string" &&
    typeof value.data === "string"
  );
}
