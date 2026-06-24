"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { AuthHead } from "@/components/auth/AuthHead";
import { Btn, Field, Icon, Input, Toggle } from "@/components/ui";
import { GoogleMark } from "@/components/auth/GoogleMark";
import { PasswordChecklist, evaluatePassword } from "@/components/auth/PasswordChecklist";

const OAUTH_ERROR_COPY: Record<string, string> = {
  provider_error: "The provider rejected the sign-in. Please try again.",
  provider_unavailable:
    "Social sign-in isn't configured. Ask an admin to set the OAuth client ID and secret.",
  missing_params: "Sign-in didn't complete — the callback was missing data.",
  missing_nonce: "Your sign-in session expired before we could complete it. Try again.",
  provider_mismatch: "The sign-in state didn't match the provider. Start over.",
  already_linked: "That account is already linked to a different DeepAgent user.",
  unverified_email: "Your provider account doesn't have a verified email. Verify it and retry.",
  incorrect_client_credentials:
    "The OAuth client ID or secret in the admin settings is wrong. Ask an admin to re-paste them in Admin → OAuth providers.",
  redirect_uri_mismatch:
    "The provider's callback URL doesn't match this site. Ask an admin to set the OAuth App's callback to this server's /api/v1/auth/oauth/<provider>/callback URL.",
  bad_verification_code:
    "The sign-in code expired or was already used. Click the button to start over.",
  unsupported_grant_type:
    "The provider's token endpoint isn't accepting our request shape. Try again or contact support.",
  exchange_http: "The provider's token endpoint returned an unexpected error. Try again.",
  token_exchange_failed: "We couldn't exchange the sign-in code with the provider.",
  exchange_failed: "We couldn't exchange the sign-in code with the provider. Try again.",
  bad_token: "The provider returned an invalid token. Try signing in again.",
};

function describeOauthError(code: string | null | undefined): string | null {
  if (!code) return null;
  return OAUTH_ERROR_COPY[code] ?? "Sign-up with that provider failed. Please try again or use email.";
}

function oauthStartUrl(provider: "github" | "google", next: string): string {
  const base = `/api/v1/auth/oauth/${provider}/start`;
  return next ? `${base}?next=${encodeURIComponent(next)}` : base;
}

function safeNext(raw: string | null): string {
  if (!raw) return "";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "";
  return raw;
}

export function SignupClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const next = safeNext(sp.get("next"));
  const prefillEmail = sp.get("email") ?? "";
  const oauthError = describeOauthError(sp.get("oauth_error"));
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: {
      firstName: "",
      lastName: "",
      email: prefillEmail,
      password: "",
      terms: false,
    },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const res = await fetch("/api/v1/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setServerError(data.message ?? "Sign-up failed.");
        return;
      }
      const target = next
        ? `/auth/2fa?setup=1&next=${encodeURIComponent(next)}`
        : "/auth/2fa?setup=1";
      router.push(target as never);
      router.refresh();
    },
  });

  return (
    <AuthFrame
      foot={
        <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
          Already have an account?{" "}
          <Link href="/auth/login" className="auth-link">
            Log in
          </Link>
        </p>
      }
    >
      <AuthHead title="Create your account" sub="Start running infrastructure in minutes — no credit card." />

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
          Sign up with GitHub
        </a>
        <a
          className="btn outline"
          style={{ display: "flex", justifyContent: "center", gap: 8 }}
          href={oauthStartUrl("google", next)}
        >
          <GoogleMark />
          Sign up with Google
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
        <div className="row gap-3">
          <form.Field
            name="firstName"
            validators={{ onChange: ({ value }) => (!value ? "Required" : undefined) }}
          >
            {(field) => (
              <Field label="First name" error={field.state.meta.errors[0]}>
                <Input
                  name={field.name}
                  autoComplete="given-name"
                  placeholder="Avery"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field
            name="lastName"
            validators={{ onChange: ({ value }) => (!value ? "Required" : undefined) }}
          >
            {(field) => (
              <Field label="Last name" error={field.state.meta.errors[0]}>
                <Input
                  name={field.name}
                  autoComplete="family-name"
                  placeholder="Chen"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </form.Field>
        </div>

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
            onChange: ({ value }) => (evaluatePassword(value).allMet ? undefined : "Password must meet all requirements"),
          }}
        >
          {(field) => (
            <div className="col" style={{ gap: 8 }}>
              <Field label="Password" error={field.state.meta.errors[0]}>
                <Input
                  name={field.name}
                  type="password"
                  autoComplete="new-password"
                  placeholder="Create a password"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
              <PasswordChecklist password={field.state.value} />
            </div>
          )}
        </form.Field>

        <form.Field
          name="terms"
          validators={{ onChange: ({ value }) => (!value ? "You must accept the Terms" : undefined) }}
        >
          {(field) => (
            <label
              className="row gap-2"
              style={{ cursor: "pointer", alignItems: "flex-start" }}
            >
              <Toggle
                ariaLabel="Accept Terms and Privacy Policy"
                checked={field.state.value}
                onCheckedChange={field.handleChange}
              />
              <span className="muted" style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                I agree to the <a className="auth-link">Terms</a> and{" "}
                <a className="auth-link">Privacy Policy</a>.
              </span>
            </label>
          )}
        </form.Field>

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
              Create account
            </Btn>
          )}
        </form.Subscribe>

        <p className="faint" style={{ fontSize: 11.5, textAlign: "center" }}>
          Two-factor authentication is required and configured on the next step.
        </p>
      </form>
    </AuthFrame>
  );
}
