"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { Btn, Field, Input, Modal, Select, type SelectOption } from "@/components/ui";
import { api } from "@/lib/api/client";

export interface AddMcpServerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional preset that pre-fills the form (Kubernetes / Terraform / blank). */
  preset?: "kubernetes" | "terraform" | null;
}

const PRESETS: Record<
  "kubernetes" | "terraform",
  { name: string; description: string; authType: "none" | "oauth" | "credential" }
> = {
  kubernetes: {
    name: "Kubernetes",
    description:
      "kubectl + cluster-state inspection. Lets agents read pods/deployments and apply manifests on demand.",
    authType: "credential",
  },
  terraform: {
    name: "Terraform",
    description:
      "terraform plan/apply over a workspace. Used by agents for infrastructure-as-code changes.",
    authType: "credential",
  },
};

const AUTH_OPTIONS: SelectOption[] = [
  { value: "none", label: "None (public endpoint)" },
  { value: "credential", label: "Credential (API key/token)" },
  { value: "oauth", label: "OAuth 2.0" },
];

export function AddMcpServerModal({ open, onOpenChange, preset }: AddMcpServerModalProps) {
  const qc = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const presetData = preset ? PRESETS[preset] : null;

  const create = useMutation({
    mutationFn: async (body: {
      name: string;
      description: string;
      authType: "none" | "oauth" | "credential";
    }) => {
      const res = await api.post<{ ok: boolean; connector?: unknown; message?: string; code?: string }>(
        "/admin/mcp",
        body,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not connect server.");
      return res.connector;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "mcp"] }),
  });

  const form = useForm({
    defaultValues: {
      name: presetData?.name ?? "",
      description: presetData?.description ?? "",
      authType: presetData?.authType ?? "none",
    },
    onSubmit: async ({ value }) => {
      setServerError(null);
      try {
        await create.mutateAsync({
          name: value.name.trim(),
          description: value.description.trim(),
          authType: value.authType as "none" | "oauth" | "credential",
        });
        form.reset();
        onOpenChange(false);
      } catch (e) {
        setServerError(e instanceof Error ? e.message : "Could not connect server.");
      }
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={preset ? `Connect ${PRESETS[preset].name}` : "Connect MCP server"}
      description="Register a Model Context Protocol server agents can call."
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Btn>
          <Btn
            variant="primary"
            icon="plus"
            loading={create.isPending}
            onClick={() => form.handleSubmit()}
          >
            Connect
          </Btn>
        </>
      }
    >
      <form
        className="col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          form.handleSubmit();
        }}
      >
        <form.Field
          name="name"
          validators={{
            onChange: ({ value }) =>
              !value.trim() ? "Name is required" : value.length > 80 ? "Max 80 characters" : undefined,
          }}
        >
          {(field) => (
            <Field label="Name" required error={field.state.meta.errors[0]}>
              <Input
                placeholder="e.g. Kubernetes (prod)"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                autoFocus
              />
            </Field>
          )}
        </form.Field>

        <form.Field
          name="description"
          validators={{
            onChange: ({ value }) =>
              !value.trim() ? "Description is required" : value.length > 280 ? "Max 280 characters" : undefined,
          }}
        >
          {(field) => (
            <Field label="Description" required error={field.state.meta.errors[0]}>
              <Input
                placeholder="What this server lets agents do…"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="authType">
          {(field) => (
            <Field label="Auth method" hint="Credentials are stored encrypted (AES-256-GCM).">
              <Select
                options={AUTH_OPTIONS}
                value={field.state.value}
                onValueChange={(v) => field.handleChange(v as "none" | "credential" | "oauth")}
                ariaLabel="Auth method"
              />
            </Field>
          )}
        </form.Field>

        {serverError && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {serverError}
          </p>
        )}
      </form>
    </Modal>
  );
}
