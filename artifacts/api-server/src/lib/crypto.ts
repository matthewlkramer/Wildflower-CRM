import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export function randomNonce(byteLen = 18): string {
  return randomBytes(byteLen).toString("base64url");
}

/**
 * AES-256-GCM at-rest encryption keyed off SESSION_SECRET. We derive a
 * 32-byte key via SHA-256 so the key is exactly the size GCM wants
 * regardless of how long the user's session secret is.
 *
 * Wire format (base64-url): iv (12 bytes) || authTag (16 bytes) ||
 * ciphertext. Anything that doesn't round-trip throws — we'd rather
 * surface a corrupted blob than silently hand back garbage.
 */

const ALG = "aes-256-gcm" as const;
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const secret = process.env["SESSION_SECRET"];
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is required for at-rest encryption of OAuth tokens",
    );
  }
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("decryptSecret: blob too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, getKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Sign a short payload (e.g. an OAuth `state` nonce) so we can hand it
 * off to a third party and trust it when it comes back. Uses HMAC-SHA-
 * 256 with SESSION_SECRET. The wire format is `<payload>.<sig>` where
 * both halves are base64-url and the signature is verified in constant
 * time.
 */

const sigKey = (): Buffer =>
  createHmac("sha256", "wf-crm-sig")
    .update(process.env["SESSION_SECRET"] ?? "")
    .digest();

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(
    s.replace(/-/g, "+").replace(/_/g, "/") + pad,
    "base64",
  );
}

export function signPayload(payload: string): string {
  if (!process.env["SESSION_SECRET"]) {
    throw new Error("SESSION_SECRET is required for signing");
  }
  const sig = createHmac("sha256", sigKey()).update(payload).digest();
  return `${b64url(Buffer.from(payload, "utf8"))}.${b64url(sig)}`;
}

export function verifyPayload(token: string): string | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let payload: Buffer;
  let sig: Buffer;
  try {
    payload = fromB64url(payloadB64);
    sig = fromB64url(sigB64);
  } catch {
    return null;
  }
  const expected = createHmac("sha256", sigKey())
    .update(payload.toString("utf8"))
    .digest();
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(sig, expected)) return null;
  return payload.toString("utf8");
}
