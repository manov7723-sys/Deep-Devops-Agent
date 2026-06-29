"use client";

import Link from "next/link";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { AuthHead } from "@/components/auth/AuthHead";
import { Btn, Field, Input } from "@/components/ui";

export function ForgotClient() {
  const [sent, setSent] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: { email: "" },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const res = await fetch("/api/v1/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setServerError(data.message ?? "Could not send reset link.");
        return;
      }
      setSent(value.email);
    },
  });

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
      {sent ? (
        <>
          <AuthHead
            icon="mail"
            iconTone="ok"
            title="Check your email"
            sub={`If an account exists for ${sent}, we just sent a reset link. It expires in 30 minutes and works once.`}
          />
          <p className="faint" style={{ fontSize: 12.5, textAlign: "center" }}>
            Didn&apos;t get it?{" "}
            <button
              type="button"
              className="auth-link"
              style={{ background: "none", border: "none", padding: 0, font: "inherit" }}
              onClick={async () => {
                // Re-issue the same POST — the server transparently dedupes
                // active tokens for the same email, so it's safe to spam.
                const res = await fetch("/api/v1/auth/forgot", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ email: sent }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data?.ok) {
                  setServerError(data?.message ?? "Could not resend reset link.");
                }
              }}
            >
              Resend
            </button>
            {" "}or{" "}
            <button
              type="button"
              className="auth-link"
              style={{ background: "none", border: "none", padding: 0, font: "inherit" }}
              onClick={() => setSent(null)}
            >
              try a different email
            </button>
          </p>
          {serverError && (
            <p style={{ fontSize: 12.5, color: "var(--danger)", textAlign: "center" }} role="alert">
              {serverError}
            </p>
          )}
        </>
      ) : (
        <>
          <AuthHead title="Forgot password?" sub="Enter your email and we'll send a reset link." />
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
                  Send reset link
                </Btn>
              )}
            </form.Subscribe>
          </form>
        </>
      )}
    </AuthFrame>
  );
}
