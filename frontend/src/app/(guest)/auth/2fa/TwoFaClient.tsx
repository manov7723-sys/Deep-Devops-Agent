"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { AuthHead } from "@/components/auth/AuthHead";
import { OtpInput } from "@/components/auth/OtpInput";
import { Btn, Icon } from "@/components/ui";

export interface TwoFaClientProps {
  setup: boolean;
}

/** Only allow same-origin paths to prevent open-redirect via ?next=. */
function safeNext(raw: string | null): string {
  if (!raw) return "";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "";
  return raw;
}

export function TwoFaClient({ setup }: TwoFaClientProps) {
  const router = useRouter();
  const sp = useSearchParams();
  const next = safeNext(sp.get("next"));
  const defaultDest = next || "/u/dashboard";
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [redirectTo, setRedirectTo] = useState<string>(defaultDest);
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [skipping, setSkipping] = useState(false);

  async function skipForNow() {
    setSkipping(true);
    setServerError(null);
    try {
      const res = await fetch("/api/v1/auth/totp-skip", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setServerError(data.message ?? "Could not skip two-factor setup.");
        setSkipping(false);
        return;
      }
      router.push((next || data.redirect || "/u/dashboard") as never);
      router.refresh();
    } catch {
      setServerError("Could not skip two-factor setup.");
      setSkipping(false);
    }
  }

  useEffect(() => {
    if (!setup) return;
    fetch("/api/v1/auth/totp-setup")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setSecret(d.secret);
          setQrDataUrl(d.qrDataUrl ?? null);
        } else {
          setServerError(d.message ?? "Could not load setup info.");
        }
      })
      .catch(() => setServerError("Could not load setup info."));
  }, [setup]);

  const filled = useBackupCode
    ? /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(code.trim())
    : code.length === 6 && /^\d{6}$/.test(code);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!filled) return;
    setSubmitting(true);
    setServerError(null);
    const endpoint = useBackupCode ? "/api/v1/auth/backup-code" : "/api/v1/auth/totp";
    const payload = useBackupCode
      ? {
          code: code
            .trim()
            .toUpperCase()
            .replace(/^([A-Z0-9]{4})([A-Z0-9]{4})$/, "$1-$2"),
        }
      : { code };
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    setSubmitting(false);
    if (!res.ok || !data.ok) {
      setServerError(data.message ?? "Verification failed.");
      return;
    }
    const dest = next || data.redirect || "/u/dashboard";
    setRedirectTo(dest);
    if (Array.isArray(data.backupCodes) && data.backupCodes.length > 0) {
      // Setup just completed — show the codes ONCE before redirecting.
      setBackupCodes(data.backupCodes);
      return;
    }
    router.push(dest as never);
    router.refresh();
  }

  function continueAfterBackupCodes() {
    // redirectTo comes from the server response; typedRoutes can't know it.
    router.push(redirectTo as never);
    router.refresh();
  }

  if (backupCodes) {
    return (
      <AuthFrame>
        <AuthHead
          icon="shield"
          title="Save your backup codes"
          sub="Store these in a password manager — each works once, only if you lose your authenticator."
        />
        <div
          className="col gap-2"
          style={{
            padding: 16,
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 14,
          }}
        >
          {backupCodes.map((c) => (
            <code key={c} className="mono">
              {c}
            </code>
          ))}
        </div>
        <div className="row gap-2">
          <Btn
            variant="outline"
            block
            onClick={() => navigator.clipboard.writeText(backupCodes.join("\n"))}
          >
            Copy all
          </Btn>
          <Btn variant="primary" block onClick={continueAfterBackupCodes} iconRight="chevR">
            I've saved them
          </Btn>
        </div>
        <p className="faint" style={{ fontSize: 11.5, textAlign: "center" }}>
          We won't show these again. Regenerate from Account → 2FA if you lose them.
        </p>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      foot={
        <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
          <Link href="/auth/login" className="auth-link">
            ← Back to log in
          </Link>
        </p>
      }
    >
      {setup ? (
        <>
          <AuthHead
            title="Secure your account"
            sub="Scan the QR code with Google Authenticator, then enter the 6-digit code."
          />
          <div className="auth-key-row">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="Two-factor setup QR code"
                width={180}
                height={180}
                style={{ borderRadius: 8, background: "#fff", padding: 4 }}
              />
            ) : (
              <div className="ph auth-qr" aria-hidden>
                QR code
              </div>
            )}
            <div className="col gap-2" style={{ minWidth: 0 }}>
              <span className="muted" style={{ fontSize: 12.5 }}>
                Or enter this key manually:
              </span>
              <code className="auth-key-code">{secret ?? "Loading…"}</code>
              <span className="faint" style={{ fontSize: 11.5 }}>
                Works with Google Authenticator, Authy, 1Password.
              </span>
            </div>
          </div>
        </>
      ) : (
        <AuthHead
          icon="shield"
          title="Two-factor authentication"
          sub={
            useBackupCode
              ? "Enter one of your backup codes (XXXX-XXXX)."
              : "Enter the 6-digit code from your authenticator app."
          }
        />
      )}

      <form className="col gap-4" onSubmit={submit} noValidate>
        {useBackupCode ? (
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
            placeholder="XXXX-XXXX"
            inputMode="text"
            autoComplete="one-time-code"
            spellCheck={false}
            style={{
              padding: "12px 14px",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 18,
              letterSpacing: 2,
              textAlign: "center",
              textTransform: "uppercase",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "transparent",
              color: "inherit",
            }}
          />
        ) : (
          <OtpInput value={code} onChange={setCode} autoFocus />
        )}

        {serverError && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {serverError}
          </p>
        )}

        <Btn
          type="submit"
          variant="primary"
          size="lg"
          block
          iconRight="chevR"
          disabled={!filled}
          loading={submitting}
        >
          {setup ? "Verify & finish setup" : "Verify & continue"}
        </Btn>

        {!setup && (
          <button
            type="button"
            onClick={() => {
              setUseBackupCode((v) => !v);
              setCode("");
              setServerError(null);
            }}
            className="auth-link"
            style={{
              background: "none",
              border: "none",
              fontSize: 12.5,
              textAlign: "center",
              cursor: "pointer",
            }}
          >
            {useBackupCode ? "Use authenticator code instead" : "Use a backup code instead"}
          </button>
        )}

        {setup && (
          <p
            className="faint row gap-2 center"
            style={{ fontSize: 12.5, justifyContent: "center" }}
          >
            <Icon name="key" size={12} />
            Enter the code from your authenticator app.
          </p>
        )}

        {setup && (
          <div className="col gap-2" style={{ marginTop: 4 }}>
            <div
              style={{
                borderTop: "1px solid var(--border)",
                paddingTop: 12,
                textAlign: "center",
              }}
            >
              <Btn
                type="button"
                variant="ghost"
                block
                onClick={skipForNow}
                loading={skipping}
                disabled={submitting}
              >
                Skip for now
              </Btn>
              <p className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
                You can enable two-factor authentication later from Account → 2FA.
              </p>
            </div>
          </div>
        )}
      </form>
    </AuthFrame>
  );
}
