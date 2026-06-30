"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { AuthHead } from "@/components/auth/AuthHead";
import { Btn, Field, Input } from "@/components/ui";
import { PasswordChecklist, evaluatePassword } from "@/components/auth/PasswordChecklist";

type TokenState =
  | { status: "checking" }
  | { status: "ok"; email: string }
  | { status: "invalid"; code: string; message: string };

export function ResetClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const token = sp.get("token") ?? "";

  const [tokenState, setTokenState] = useState<TokenState>({ status: "checking" });
  const [serverError, setServerError] = useState<string | null>(null);

  // Validate the token up-front so we can show "expired" / "already used"
  // states before the user types a new password.
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setTokenState({
        status: "invalid",
        code: "missing_token",
        message: "Open this page from the link in your password-reset email.",
      });
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/v1/auth/reset?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && data.ok) {
          setTokenState({ status: "ok", email: data.email });
        } else {
          setTokenState({
            status: "invalid",
            code: data.code ?? "invalid_token",
            message: data.message ?? "This reset link is no longer valid.",
          });
        }
      } catch {
        if (!cancelled) {
          setTokenState({
            status: "invalid",
            code: "network",
            message: "Couldn't reach the server. Please try again.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const form = useForm({
    defaultValues: { password: "", confirmPassword: "" },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const res = await fetch("/api/v1/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          password: value.password,
          confirmPassword: value.confirmPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setServerError(data.message ?? "Could not reset password.");
        return;
      }
      router.push("/auth/login?reset=ok");
    },
  });

  const back = (
    <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
      <Link href="/auth/login" className="auth-link">
        ← Back to log in
      </Link>
    </p>
  );

  if (tokenState.status === "checking") {
    return (
      <AuthFrame foot={back}>
        <AuthHead title="Verifying reset link" sub="Just a moment…" />
      </AuthFrame>
    );
  }

  if (tokenState.status === "invalid") {
    return (
      <AuthFrame foot={back}>
        <AuthHead
          icon="alert"
          iconTone="warn"
          title="This reset link can't be used"
          sub={tokenState.message}
        />
        <Link href="/auth/forgot" className="btn primary lg block">
          Request a new link
        </Link>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame foot={back}>
      <AuthHead
        title="Set a new password"
        sub={`Resetting password for ${tokenState.email}. Choose a strong password you haven't used before.`}
      />

      <form
        className="col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          form.handleSubmit();
        }}
        noValidate
      >
        <form.Field
          name="password"
          validators={{
            onChange: ({ value }) => (evaluatePassword(value).allMet ? undefined : "Password must meet all requirements"),
          }}
        >
          {(field) => (
            <Field label="New password" error={field.state.meta.errors[0]}>
              <Input
                name={field.name}
                type="password"
                autoComplete="new-password"
                placeholder="New password"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <form.Field
          name="confirmPassword"
          validators={{
            onChangeListenTo: ["password"],
            onChange: ({ value, fieldApi }) => {
              const pw = fieldApi.form.getFieldValue("password");
              if (!value) return "Required";
              if (value !== pw) return "Passwords do not match";
              return undefined;
            },
          }}
        >
          {(field) => (
            <Field label="Confirm password" error={field.state.meta.errors[0]}>
              <Input
                name={field.name}
                type="password"
                autoComplete="new-password"
                placeholder="Re-enter password"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <form.Subscribe selector={(s) => s.values.password}>
          {(pw) => <PasswordChecklist password={pw} />}
        </form.Subscribe>

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
              disabled={!canSubmit}
              loading={isSubmitting}
            >
              Reset password & log in
            </Btn>
          )}
        </form.Subscribe>
      </form>
    </AuthFrame>
  );
}
