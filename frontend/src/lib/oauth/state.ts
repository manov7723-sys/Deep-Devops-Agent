/**
 * HMAC-SHA256 signed OAuth state token. Anchored on APP_SECRET_KEY (the same
 * 32-byte key that encrypts at-rest secrets) so anyone able to forge state
 * could already decrypt our secrets.
 *
 * Payload (base64url):  provider | nonce | issuedAtMs
 * Token:                payload + "." + base64url(HMAC(payload))
 *
 * Validation rejects anything older than TTL_MS or with a mismatched HMAC.
 * Nonce uniqueness is enforced via a cookie (single-use per request) — we
 * don't store nonces server-side because the cookie + HMAC pair is already
 * tightly bound to a single in-flight authorize redirect.
 */
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";

const TTL_MS = 10 * 60 * 1000;

/**
 * HMAC key for signed payloads (OAuth state, anything else that needs a
 * tamper-evident token). Prefer JWT_SIGNING_KEY when set so signing keys can
 * be rotated independently from at-rest encryption keys. Falls back to
 * APP_SECRET_KEY for back-compat, then to a deterministic dev seed.
 */
function keyBytes(): Buffer {
  const raw = process.env.JWT_SIGNING_KEY ?? process.env.APP_SECRET_KEY;
  if (raw) {
    // Either a base64 32-byte key (preferred) or any length string — we hash
    // it to 32 bytes so JWT_SIGNING_KEY can be a long random string without
    // strict length requirements.
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
    return createHash("sha256").update(raw).digest();
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SIGNING_KEY (or APP_SECRET_KEY) is required in production.");
  }
  const seed = process.env.DATABASE_URL ?? "deepagent-dev-fallback";
  return createHash("sha256").update(`dda:dev:${seed}`).digest();
}

export type StateInput = {
  provider: string;
  nonce: string;
  issuedAtMs: number;
  /** True when the flow runs in a popup (callback closes it instead of redirecting). */
  popup?: boolean;
  /** Post-auth return path. Carried IN the signed state so it survives the
   *  cross-site GitHub round-trip reliably (cookies can be dropped on some
   *  browsers for popups). */
  next?: string | null;
};

export function generateNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function signState(input: StateInput): string {
  // payload: provider | nonce | issuedAtMs | popup("1"/"0") | base64url(next)
  // next is base64url-encoded so its `?`,`&`,`|` chars can't break the split.
  const nextB64 = input.next ? Buffer.from(input.next, "utf8").toString("base64url") : "";
  const popup = input.popup ? "1" : "0";
  const payload = `${input.provider}|${input.nonce}|${input.issuedAtMs}|${popup}|${nextB64}`;
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = createHmac("sha256", keyBytes()).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

export type VerifyResult =
  | { ok: true; provider: string; nonce: string; issuedAtMs: number; popup: boolean; next: string | null }
  | { ok: false; code: "malformed" | "bad_sig" | "expired" };

export function verifyState(token: string, expectedNonce: string): VerifyResult {
  const dot = token.indexOf(".");
  if (dot < 1) return { ok: false, code: "malformed" };
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = createHmac("sha256", keyBytes()).update(payloadB64).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: "bad_sig" };
  }

  const raw = Buffer.from(payloadB64, "base64url").toString("utf8");
  const parts = raw.split("|");
  // 3 parts = legacy token (no popup/next); 5 parts = current.
  if (parts.length !== 3 && parts.length !== 5) return { ok: false, code: "malformed" };
  const [provider, nonce, issuedAtStr, popupStr, nextB64] = parts;
  const issuedAtMs = Number(issuedAtStr);
  if (!Number.isFinite(issuedAtMs)) return { ok: false, code: "malformed" };
  if (Date.now() - issuedAtMs > TTL_MS) return { ok: false, code: "expired" };

  if (nonce !== expectedNonce) return { ok: false, code: "bad_sig" };

  const next = nextB64 ? Buffer.from(nextB64, "base64url").toString("utf8") : null;
  return {
    ok: true,
    provider: provider!,
    nonce: nonce!,
    issuedAtMs,
    popup: popupStr === "1",
    next,
  };
}
