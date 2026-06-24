/**
 * AES-256-GCM encryption for secrets stored in the DB (TotpCredential.secretRef,
 * IntegrationOAuth.accessTokenRef, etc).
 *
 * Key comes from APP_SECRET_KEY: a base64-encoded 32-byte key. In dev a
 * deterministic fallback is generated from the DATABASE_URL so the same DB
 * stays decryptable across restarts; in production the env var is REQUIRED.
 *
 * Wire format: base64url( iv(12) || ciphertext || authTag(16) ).
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function decodeBase64Key(raw: string, label: string): Buffer {
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `${label} must decode to 32 bytes (got ${buf.length}). Generate one with: openssl rand -base64 32`,
    );
  }
  return buf;
}

function devFallbackKey(domain: string): Buffer {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`A key for ${domain} is required in production.`);
  }
  const seed = process.env.DATABASE_URL ?? "deepagent-dev-fallback";
  // eslint-disable-next-line no-console
  console.warn(
    `[crypto] no key set for ${domain} — using deterministic dev fallback. DO NOT USE IN PRODUCTION.`,
  );
  return createHash("sha256").update(`dda:dev:${domain}:${seed}`).digest();
}

/** Resolve the AES-256-GCM key for a given purpose.
 *
 * Two-factor secrets use TWO_FACTOR_ENCRYPTION_KEY when set so the TOTP keys
 * can be rotated independently of the general APP_SECRET_KEY. Everything else
 * (integration credentials, MCP credentials, OAuth tokens, env vars) falls
 * back to APP_SECRET_KEY. Both have the same shape: base64(32 bytes).
 */
let cached2fa: Buffer | null = null;
let cachedApp: Buffer | null = null;

function twoFactorKey(): Buffer {
  if (cached2fa) return cached2fa;
  const raw = process.env.TWO_FACTOR_ENCRYPTION_KEY ?? process.env.APP_SECRET_KEY;
  cached2fa = raw
    ? decodeBase64Key(raw, "TWO_FACTOR_ENCRYPTION_KEY / APP_SECRET_KEY")
    : devFallbackKey("two_factor");
  return cached2fa;
}

function appKey(): Buffer {
  if (cachedApp) return cachedApp;
  const raw = process.env.APP_SECRET_KEY;
  cachedApp = raw ? decodeBase64Key(raw, "APP_SECRET_KEY") : devFallbackKey("app");
  return cachedApp;
}

/** Domains decide which key gets used. "totp" picks TWO_FACTOR_ENCRYPTION_KEY;
 *  anything else uses APP_SECRET_KEY. */
type KeyDomain = "totp" | "app";

function key(domain: KeyDomain = "app"): Buffer {
  return domain === "totp" ? twoFactorKey() : appKey();
}

export function encryptSecret(plaintext: string, domain: KeyDomain = "app"): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key(domain), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString("base64url");
}

export function decryptSecret(payload: string, domain: KeyDomain = "app"): string {
  const buf = Buffer.from(payload, "base64url");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("ciphertext too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const enc = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALG, key(domain), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
