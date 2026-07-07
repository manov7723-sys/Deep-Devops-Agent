"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Btn, Field, Icon, Input, Modal } from "@/components/ui";
import { api } from "@/lib/api/client";

export interface EditCloudProviderModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Real CloudProvider.id (UUID). */
  providerId: string;
  /** Provider kind drives label hints. */
  kind: "aws" | "gcp" | "azure" | string;
  /** Current values pre-fill the form. */
  initial: {
    name: string;
    region: string;
  };
  /** Optional project slug — used to invalidate the project's `providers` query after save. */
  projectSlug?: string;
}

const CRED_LABEL: Record<string, { label: string; placeholder: string; hint: string }> = {
  aws: {
    label: "IAM role ARN",
    placeholder: "arn:aws:iam::461298145672:role/deep-agent",
    hint: "Scoped IAM role Deep Agent assumes via STS.",
  },
  gcp: {
    label: "Service account email",
    placeholder: "deep-agent@your-project.iam.gserviceaccount.com",
    hint: "Workload-identity service account Deep Agent impersonates.",
  },
  azure: {
    label: "App (Client) ID",
    placeholder: "00000000-0000-0000-0000-000000000000",
    hint: "Service principal in your Entra tenant.",
  },
  proxmox: {
    label: "API token ID",
    placeholder: "root@pam!deepagent",
    hint: 'Proxmox API token ID ("user@realm!tokenname").',
  },
};

const EXTRA_LABEL: Record<string, { label: string; placeholder: string; hint: string }> = {
  aws: {
    label: "STS ExternalId",
    placeholder: "dda-…",
    hint: "Cross-account safety value. Leave blank to keep current.",
  },
  gcp: {
    label: "Workload-identity pool",
    placeholder: "projects/.../workloadIdentityPools/…",
    hint: "Optional. Leave blank to keep current.",
  },
  azure: {
    label: "Client secret",
    placeholder: "leave blank to keep current secret",
    hint: "AES-256-GCM encrypted at rest.",
  },
  proxmox: {
    label: "API token secret",
    placeholder: "leave blank to keep current secret",
    hint: "AES-256-GCM encrypted at rest.",
  },
};

export function EditCloudProviderModal({
  open,
  onOpenChange,
  providerId,
  kind,
  initial,
  projectSlug,
}: EditCloudProviderModalProps) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial.name);
  const [region, setRegion] = useState(initial.region);
  const [roleArn, setRoleArn] = useState("");
  const [externalId, setExternalId] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Re-sync local state every time the modal opens — the initial values may
  // change between opens (e.g. user edits two providers in sequence).
  useEffect(() => {
    if (!open) return;
    setName(initial.name);
    setRegion(initial.region);
    setRoleArn("");
    setExternalId("");
    setServerError(null);
    setConfirmDelete(false);
  }, [open, initial.name, initial.region]);

  const credLabel = CRED_LABEL[kind] ?? CRED_LABEL.aws;
  const extraLabel = EXTRA_LABEL[kind] ?? EXTRA_LABEL.aws;

  async function invalidateAll() {
    await qc.invalidateQueries({ queryKey: ["cloud-providers"] });
    if (projectSlug) await qc.invalidateQueries({ queryKey: ["p", projectSlug] });
  }

  const save = useMutation({
    mutationFn: async () => {
      // Build a PATCH body of only changed fields. Empty cred fields mean
      // "don't touch" — we never want to overwrite a stored cred with "".
      const patch: Record<string, string> = {};
      if (name.trim() && name !== initial.name) patch.name = name.trim();
      if (region.trim() && region !== initial.region) patch.region = region.trim();
      if (roleArn.trim()) patch.roleArn = roleArn.trim();
      if (externalId.trim()) patch.externalId = externalId.trim();
      if (Object.keys(patch).length === 0) {
        return { ok: true, noop: true };
      }
      const res = await api.patch<{ ok: boolean; message?: string; code?: string }>(
        `/cloud-providers/${providerId}`,
        patch,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not save provider.");
      return res;
    },
    onSuccess: async () => {
      await invalidateAll();
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await api.del<{ ok: boolean; message?: string; code?: string }>(
        `/cloud-providers/${providerId}`,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not disconnect.");
      return res;
    },
    onSuccess: async () => {
      await invalidateAll();
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${kind.toUpperCase()} provider`}
      description="Update the display name, region or rotate credentials."
      footer={
        confirmDelete ? (
          <>
            <Btn variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Btn>
            <Btn
              variant="primary"
              icon="x"
              loading={remove.isPending}
              onClick={async () => {
                setServerError(null);
                try {
                  await remove.mutateAsync();
                  onOpenChange(false);
                } catch (e) {
                  setServerError(e instanceof Error ? e.message : "Could not disconnect.");
                }
              }}
              style={{ background: "var(--danger)", borderColor: "var(--danger)" }}
            >
              Yes, disconnect
            </Btn>
          </>
        ) : (
          <>
            <Btn variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Btn>
            <Btn
              variant="primary"
              icon="check"
              loading={save.isPending}
              onClick={async () => {
                setServerError(null);
                try {
                  await save.mutateAsync();
                  onOpenChange(false);
                } catch (e) {
                  setServerError(e instanceof Error ? e.message : "Could not save.");
                }
              }}
            >
              Save changes
            </Btn>
          </>
        )
      }
    >
      <div className="col gap-4">
        <Field label="Display name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Default region" hint="Per-env regions can override this.">
          <Input value={region} onChange={(e) => setRegion(e.target.value)} />
        </Field>

        <Field
          label={credLabel.label}
          hint={`${credLabel.hint} Leave blank to keep current value.`}
        >
          <Input
            className="mono"
            placeholder={credLabel.placeholder}
            value={roleArn}
            onChange={(e) => setRoleArn(e.target.value)}
          />
        </Field>

        <Field label={extraLabel.label} hint={extraLabel.hint}>
          <Input
            type="password"
            className="mono"
            placeholder={extraLabel.placeholder}
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
          />
        </Field>

        <div
          className="row gap-2"
          style={{
            padding: 12,
            background: "var(--info-soft)",
            borderRadius: 10,
            color: "var(--info)",
            fontSize: 12.5,
          }}
        >
          <Icon name="shield" size={16} style={{ flex: "none" }} />
          New credentials replace stored ones and are encrypted at rest with AES-256-GCM. Blank fields don't touch the existing values.
        </div>

        {serverError && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {serverError}
          </p>
        )}

        {/* Danger zone */}
        <div
          className="col gap-2"
          style={{
            borderTop: "1px solid var(--border)",
            paddingTop: 12,
            marginTop: 4,
          }}
        >
          {confirmDelete ? (
            <p style={{ fontSize: 13, color: "var(--danger)" }}>
              Disconnecting <b>{initial.name}</b> will unbind it from every environment using
              it. This can't be undone here — you'd have to reconnect from scratch.
            </p>
          ) : (
            <button
              type="button"
              className="auth-link"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                fontSize: 12.5,
                color: "var(--danger)",
                cursor: "pointer",
                textAlign: "left",
              }}
              onClick={() => setConfirmDelete(true)}
            >
              Disconnect this provider…
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
