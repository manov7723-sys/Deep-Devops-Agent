"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { Block, Btn, Field, Input, PageHead } from "@/components/ui";
import { PasswordChecklist, evaluatePassword } from "@/components/auth/PasswordChecklist";
import { useChangePassword } from "@/hooks/queries/account";

export function ChangePasswordClient() {
  const router = useRouter();
  const change = useChangePassword();
  const [serverError, setServerError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const form = useForm({
    defaultValues: { current: "", password: "", confirmPassword: "" },
    onSubmit: async ({ value }) => {
      setServerError(null);
      try {
        await change.mutateAsync(value);
        setSuccess(true);
        setTimeout(() => router.push("/account/profile"), 800);
      } catch (e) {
        setServerError(e instanceof Error ? e.message : "Could not change password.");
      }
    },
  });

  return (
    <div className="col gap-5" style={{ maxWidth: 560 }}>
      <PageHead title="Change password" sub="Use a strong password you don't reuse elsewhere." />
      <Block>
        <Block.Body>
          <form
            className="col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              form.handleSubmit();
            }}
          >
            <form.Field
              name="current"
              validators={{ onChange: ({ value }) => (!value ? "Required" : undefined) }}
            >
              {(field) => (
                <Field label="Current password" required error={field.state.meta.errors[0]}>
                  <Input
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

            <form.Field
              name="password"
              validators={{
                onChange: ({ value }) =>
                  evaluatePassword(value).allMet
                    ? undefined
                    : "Password must meet all requirements",
              }}
            >
              {(field) => (
                <Field label="New password" required error={field.state.meta.errors[0]}>
                  <Input
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
                <Field label="Confirm new password" required error={field.state.meta.errors[0]}>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder="Re-enter new password"
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
            {success && (
              <p style={{ fontSize: 12.5, color: "var(--ok)" }} role="status">
                Password updated.
              </p>
            )}

            <div className="row gap-2 between">
              <Btn type="button" variant="ghost" onClick={() => router.push("/account/profile")}>
                Cancel
              </Btn>
              <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
                {([canSubmit, isSubmitting]) => (
                  <Btn type="submit" variant="primary" disabled={!canSubmit} loading={isSubmitting}>
                    Update password
                  </Btn>
                )}
              </form.Subscribe>
            </div>
          </form>
        </Block.Body>
      </Block>
    </div>
  );
}
