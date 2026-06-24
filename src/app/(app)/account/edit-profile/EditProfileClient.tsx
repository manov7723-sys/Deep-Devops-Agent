"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { Avatar, Block, Btn, Field, Input, PageHead, Select } from "@/components/ui";
import { useProfile, useUpdateProfile, type Profile } from "@/hooks/queries/account";

const TIMEZONES = [
  { value: "America/Los_Angeles", label: "(GMT-08:00) Pacific" },
  { value: "America/New_York", label: "(GMT-05:00) Eastern" },
  { value: "Europe/London", label: "(GMT+00:00) UTC" },
  { value: "Asia/Kolkata", label: "(GMT+05:30) India Standard Time" },
  { value: "Asia/Tokyo", label: "(GMT+09:00) Japan" },
];

const DEFAULTS: Profile = {
  firstName: "",
  lastName: "",
  email: "",
  jobTitle: "",
  timezone: "America/Los_Angeles",
};

export function EditProfileClient() {
  const router = useRouter();
  const { data: profile } = useProfile();
  const update = useUpdateProfile();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: DEFAULTS,
    onSubmit: async ({ value }) => {
      setServerError(null);
      try {
        await update.mutateAsync(value);
        router.push("/account/profile");
        router.refresh();
      } catch (e) {
        setServerError(e instanceof Error ? e.message : "Could not save changes.");
      }
    },
  });

  // Reset form whenever the server profile changes.
  useEffect(() => {
    if (profile) form.reset(profile);
  }, [profile, form]);

  if (!profile) {
    return (
      <div className="col gap-5" style={{ maxWidth: 680 }}>
        <PageHead title="Edit profile" sub="Update your personal information." />
        <Block><Block.Loading /></Block>
      </div>
    );
  }

  const fullName = `${form.state.values.firstName} ${form.state.values.lastName}`.trim() || profile.email;

  return (
    <div className="col gap-5" style={{ maxWidth: 680 }}>
      <PageHead title="Edit profile" sub="Update your personal information." />
      <Block>
        <Block.Body>
          <form
            className="col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              form.handleSubmit();
            }}
          >
            <div className="row gap-4" style={{ alignItems: "center", flexWrap: "wrap" }}>
              <Avatar name={fullName} size={68} />
              <div className="row gap-2">
                <Btn type="button" variant="outline" icon="download">Upload photo</Btn>
                <Btn type="button" variant="ghost">Remove</Btn>
              </div>
            </div>
            <div className="divider" />
            <div className="row gap-3 wrap">
              <div className="grow" style={{ minWidth: 200 }}>
                <form.Field name="firstName" validators={{ onChange: ({ value }) => (!value ? "Required" : undefined) }}>
                  {(field) => (
                    <Field label="First name" required error={field.state.meta.errors[0]}>
                      <Input
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                    </Field>
                  )}
                </form.Field>
              </div>
              <div className="grow" style={{ minWidth: 200 }}>
                <form.Field name="lastName">
                  {(field) => (
                    <Field label="Last name">
                      <Input
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                    </Field>
                  )}
                </form.Field>
              </div>
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
                <Field label="Email" required error={field.state.meta.errors[0]}>
                  <Input
                    type="email"
                    autoComplete="email"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </Field>
              )}
            </form.Field>

            <form.Field name="jobTitle">
              {(field) => (
                <Field label="Job title">
                  <Input
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </Field>
              )}
            </form.Field>

            <form.Field name="timezone">
              {(field) => (
                <Field label="Timezone">
                  <Select
                    value={field.state.value}
                    onValueChange={field.handleChange}
                    ariaLabel="Timezone"
                    options={TIMEZONES}
                  />
                </Field>
              )}
            </form.Field>

            {serverError && (
              <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">{serverError}</p>
            )}

            <div className="row gap-2 between">
              <Btn type="button" variant="ghost" onClick={() => router.push("/account/profile")}>
                Cancel
              </Btn>
              <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
                {([canSubmit, isSubmitting]) => (
                  <Btn type="submit" variant="primary" icon="check" disabled={!canSubmit} loading={isSubmitting}>
                    Save changes
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
