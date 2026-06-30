"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { Btn, Field, Input, Modal, Select, type SelectOption, Textarea, Toggle } from "@/components/ui";
import { api } from "@/lib/api/client";

export interface AddEnvModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
}

const PRESETS: SelectOption[] = [
  { value: "alpha", label: "Alpha — daily branch builds" },
  { value: "beta", label: "Beta — release candidates" },
  { value: "release", label: "Release — production" },
  { value: "staging", label: "Staging — pre-prod mirror" },
  { value: "preview", label: "Preview — PR-scoped" },
  { value: "_custom", label: "Custom…" },
];

/** Quick env-create modal. Wraps POST /projects/[slug]/envs. */
export function AddEnvModal({ open, onOpenChange, projectSlug }: AddEnvModalProps) {
  const qc = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const [preset, setPreset] = useState("alpha");
  const [isProd, setIsProd] = useState(false);
  const [autoDeploy, setAutoDeploy] = useState(true);

  const create = useMutation({
    mutationFn: async (body: {
      key: string;
      name: string;
      isProduction: boolean;
      autoDeploy: boolean;
      promotionRank: number;
      region?: string;
      terraformWorkspace?: string;
      kubeconfig?: string;
      namespace?: string;
    }) => {
      const res = await api.post<{ ok: boolean; env?: { id: string; key: string }; message?: string; code?: string }>(
        `/projects/${projectSlug}/envs`,
        body,
      );
      if (!res.ok || !res.env) throw new Error(res.message ?? res.code ?? "Could not create env.");
      return res.env;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", projectSlug] }),
  });

  const form = useForm({
    defaultValues: {
      key: "alpha",
      name: "Alpha",
      region: "",
      terraformWorkspace: "",
      namespace: "default",
      kubeconfig: "",
    },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const key = value.key.trim().toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(key)) {
        setServerError('Env key must be lowercase letters, numbers, or "-".');
        return;
      }
      try {
        await create.mutateAsync({
          key,
          name: value.name.trim() || key,
          isProduction: isProd,
          autoDeploy,
          promotionRank: 0,
          region: value.region.trim() || undefined,
          terraformWorkspace: value.terraformWorkspace.trim() || undefined,
          namespace: value.namespace.trim() || undefined,
          kubeconfig: value.kubeconfig.trim() || undefined,
        });
        form.reset();
        setPreset("alpha");
        setIsProd(false);
        setAutoDeploy(true);
        onOpenChange(false);
      } catch (e) {
        setServerError(e instanceof Error ? e.message : "Could not create env.");
      }
    },
  });

  function applyPreset(v: string) {
    setPreset(v);
    if (v === "_custom") {
      form.setFieldValue("key", "");
      form.setFieldValue("name", "");
      setIsProd(false);
      setAutoDeploy(true);
      return;
    }
    form.setFieldValue("key", v);
    form.setFieldValue(
      "name",
      v === "alpha" ? "Alpha" : v === "beta" ? "Beta" : v === "release" ? "Release" : v === "staging" ? "Staging" : "Preview",
    );
    setIsProd(v === "release");
    setAutoDeploy(v !== "release");
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add environment"
      description="Environments group deployments + cloud bindings."
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Btn>
          <Btn variant="primary" icon="plus" loading={create.isPending} onClick={() => form.handleSubmit()}>
            Create env
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
        <Field label="Preset" hint="Pick a preset for sensible defaults, or choose Custom.">
          <Select options={PRESETS} value={preset} onValueChange={applyPreset} ariaLabel="Preset" />
        </Field>

        <div className="row gap-3">
          <form.Field name="key">
            {(field) => (
              <Field label="Key" required hint="Lowercase identifier used in URLs and the env filter.">
                <Input
                  className="mono"
                  placeholder="alpha"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  autoFocus
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="name">
            {(field) => (
              <Field label="Display name" required>
                <Input
                  placeholder="Alpha"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </form.Field>
        </div>

        <form.Field name="region">
          {(field) => (
            <Field label="Region" hint="Optional — defaults from the bound cloud provider if set.">
              <Input
                placeholder="us-east-1"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="terraformWorkspace">
          {(field) => (
            <Field
              label="Terraform workspace"
              hint={`Optional — IaC workspace backing this env. Defaults to "${projectSlug}-${form.state.values.key || "<key>"}" if left blank.`}
            >
              <Input
                className="mono"
                placeholder={`${projectSlug}-${form.state.values.key || "alpha"}`}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <div className="row between">
          <span>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Production</span>
            <br />
            <span className="faint" style={{ fontSize: 11.5 }}>Triggers approval on every deploy.</span>
          </span>
          <Toggle checked={isProd} onCheckedChange={setIsProd} ariaLabel="Production" />
        </div>
        <div className="row between">
          <span>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Auto-deploy</span>
            <br />
            <span className="faint" style={{ fontSize: 11.5 }}>Push to the env's branch → automatic pipeline.</span>
          </span>
          <Toggle checked={autoDeploy} onCheckedChange={setAutoDeploy} ariaLabel="Auto-deploy" />
        </div>

        {/* ── Cluster wiring (Phase 1, optional at create) ──────────── */}
        <div
          className="col gap-3"
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 12,
            background: "var(--surface-2)",
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 13 }}>
            Kubernetes cluster <span className="faint" style={{ fontWeight: 400 }}>(optional)</span>
          </span>
          <span className="faint" style={{ fontSize: 11.5 }}>
            Paste a kubeconfig now to wire this env immediately, or skip and add it later from env
            settings.
          </span>
          <form.Field name="namespace">
            {(field) => (
              <Field label="Namespace" hint="Namespace where deployments land. Defaults to 'default'.">
                <Input
                  className="mono"
                  placeholder="default"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="kubeconfig">
            {(field) => (
              <Field
                label="Kubeconfig YAML"
                hint="Encrypted at rest with AES-GCM. Leave blank to add later."
              >
                <Textarea
                  rows={4}
                  className="mono"
                  style={{ fontSize: 12 }}
                  placeholder="apiVersion: v1&#10;clusters:&#10;- cluster:&#10;    server: https://..."
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </form.Field>
        </div>

        {serverError && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {serverError}
          </p>
        )}
      </form>
    </Modal>
  );
}
