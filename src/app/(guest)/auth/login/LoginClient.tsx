"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { AuthHead } from "@/components/auth/AuthHead";
import { GoogleMark } from "@/components/auth/GoogleMark";
import { Btn, Field, Icon, Input, Toggle } from "@/components/ui";

/** Build the OAuth start URL; preserves the post-auth `next` redirect. */
function oauthStartUrl(provider: "github" | "google", next: string): string {
  const base = `/api/v1/auth/oauth/${provider}/start`;
  return next ? `${base}?next=${encodeURIComponent(next)}` : base;
}

/** Only allow same-origin paths to prevent open-redirect via ?next=. */
function safeNext(raw: string | null): string {
  if (!raw) return "";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "";
  return raw;
}

/**
 * Map OAuth callback failure codes (set by the callback route via
 * `?oauth_error=…`) to user-facing copy. Falls back to a generic message
 * for unknown codes — but always shows the user *something* went wrong.
 */
const OAUTH_ERROR_COPY: Record<string, string> = {
  provider_error: "The provider rejected the sign-in. Please try again.",
  provider_unavailable: "Social sign-in isn't configured. Ask an admin to set the OAuth client ID and secret.",
  missing_params: "Sign-in didn't complete — the callback was missing data.",
  missing_nonce: "Your sign-in session expired before we could complete it. Try again.",
  provider_mismatch: "The sign-in state didn't match the provider. Start over.",
  already_linked: "That account is already linked to a different DeepAgent user.",
  unverified_email: "Your provider account doesn't have a verified email. Verify it and retry.",
  // Granular exchange failures — the user sees exactly what went wrong.
  incorrect_client_credentials:
    "The OAuth client ID or secret in the admin settings is wrong. Ask an admin to re-paste them in Admin → OAuth providers.",
  redirect_uri_mismatch:
    "The provider's callback URL doesn't match this site. Ask an admin to set the OAuth App's callback to this server's /api/v1/auth/oauth/<provider>/callback URL.",
  bad_verification_code:
    "The sign-in code expired or was already used. Click the button to start over.",
  unsupported_grant_type:
    "The provider's token endpoint isn't accepting our request shape. Try again or contact support.",
  exchange_http: "The provider's token endpoint returned an unexpected error. Try again.",
  // Legacy generic — kept as a fallback for older audit rows.
  token_exchange_failed: "We couldn't exchange the sign-in code with the provider.",
  exchange_failed: "We couldn't exchange the sign-in code with the provider. Try again.",
  bad_token: "The provider returned an invalid token. Try signing in again.",
};

function describeOauthError(code: string | null | undefined): string | null {
  if (!code) return null;
  return OAUTH_ERROR_COPY[code] ?? "Sign-in with that provider failed. Please try again or use email.";
}

export function LoginClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const next = safeNext(sp.get("next"));
  const prefillEmail = sp.get("email") ?? "";
  const oauthError = describeOauthError(sp.get("oauth_error"));
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: { email: prefillEmail, password: "", remember: true },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setServerError(data.message ?? "Sign-in failed.");
        return;
      }
      const target = next ? `/auth/2fa?next=${encodeURIComponent(next)}` : "/auth/2fa";
      router.push(target as never);
      router.refresh();
    },
  });

  return (
    <AuthFrame
      foot={
        <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
          New here?{" "}
          <Link href="/auth/signup" className="auth-link">
            Create an account
          </Link>
        </p>
      }
    >
      <AuthHead title="Welcome back" sub="Log in to your DeepAgent workspace." />

      {oauthError && (
        <div
          role="alert"
          style={{
            padding: "10px 12px",
            background: "var(--danger-soft)",
            color: "var(--danger)",
            borderRadius: 10,
            fontSize: 13,
            marginBottom: 12,
            lineHeight: 1.45,
          }}
        >
          {oauthError}
        </div>
      )}

      <div className="col gap-3">
        <a
          className="btn outline"
          style={{ display: "flex", justifyContent: "center", gap: 8 }}
          href={oauthStartUrl("github", next)}
        >
          <Icon name="github" size={16} />
          Continue with GitHub
        </a>
        <a
          className="btn outline"
          style={{ display: "flex", justifyContent: "center", gap: 8 }}
          href={oauthStartUrl("google", next)}
        >
          <GoogleMark />
          Continue with Google
        </a>
      </div>

      <div className="auth-divider">
        <div className="divider" />
        <span>or</span>
        <div className="divider" />
      </div>

      <form
        className="col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          form.handleSubmit();
        }}
        noValidate
      >
        <form.Field
          name="email"
          validators={{
            onChange: ({ value }) =>
              !value
                ? "Email is required"
                : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
                  ? "Enter a valid email"
                  : undefined,
          }}
        >
          {(field) => (
            <Field label="Work email" error={field.state.meta.errors[0]}>
              <Input
                name={field.name}
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <form.Field
          name="password"
          validators={{
            onChange: ({ value }) =>
              !value ? "Password is required" : value.length < 8 ? "At least 8 characters" : undefined,
          }}
        >
          {(field) => (
            <Field label="Password" error={field.state.meta.errors[0]}>
              <Input
                name={field.name}
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <div className="row between">
          <form.Field name="remember">
            {(field) => (
              <label className="row gap-2" style={{ cursor: "pointer" }}>
                <Toggle
                  ariaLabel="Remember me"
                  checked={field.state.value}
                  onCheckedChange={field.handleChange}
                />
                <span style={{ fontSize: 13, fontWeight: 600 }}>Remember me</span>
              </label>
            )}
          </form.Field>
          <Link href="/auth/forgot" className="auth-link" style={{ fontSize: 13 }}>
            Forgot password?
          </Link>
        </div>

        {serverError && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {serverError}
          </p>
        )}

        <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Btn
              type="submit"
              variant="primary"
              size="lg"
              block
              iconRight="chevR"
              disabled={!canSubmit}
              loading={isSubmitting}
            >
              Log in
            </Btn>
          )}
        </form.Subscribe>

        <p className="faint" style={{ fontSize: 11.5, textAlign: "center" }}>
          Demo: any email + any 8-char password works. TOTP code on the next step is{" "}
          <code className="mono">123456</code>.
        </p>
      </form>
    </AuthFrame>
  );
}
