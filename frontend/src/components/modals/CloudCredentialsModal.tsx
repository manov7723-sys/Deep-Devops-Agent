"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Btn, Field, Input, Modal } from "@/components/ui";
import { api } from "@/lib/api/client";

export interface CloudCredentialsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** CloudProvider id (real DB id, not the visual "kind" id). */
  providerId: string | null;
  providerName: string;
  /** Project slug — used to invalidate the providers list after a change. */
  slug: string;
}

type CredStatus = { hasAwsKeysStored: boolean };

/**
 * Store / clear a provider's AWS access key + secret, AES-256-GCM encrypted
 * directly on the CloudProvider row — the same tier as Azure's stored
 * Service-Principal secret. No external service to connect first.
 */
export function CloudCredentialsModal({
  open,
  onOpenChange,
  providerId,
  providerName,
  slug,
}: CloudCredentialsModalProps) {
  const qc = useQueryClient();
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [region, setRegion] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAccessKeyId("");
    setSecretAccessKey("");
    setRegion("");
    setServerError(null);
  }, [open, providerId]);

  const cred = useQuery<CredStatus>({
    queryKey: ["cloud-provider", providerId, "credentials"],
    queryFn: () => api.get<CredStatus>(`/cloud-providers/${providerId}/credentials`),
    enabled: open && !!providerId,
    staleTime: 10_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["p", slug] });
    qc.invalidateQueries({ queryKey: ["cloud-provider", providerId, "credentials"] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.post(`/cloud-providers/${providerId}/credentials`, {
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        ...(region.trim() ? { region: region.trim() } : {}),
      }),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
    },
    onError: (e: unknown) => setServerError(errMsg(e)),
  });

  const clear = useMutation({
    mutationFn: () => api.del(`/cloud-providers/${providerId}/credentials`),
    onSuccess: () => {
      invalidate();
      setAccessKeyId("");
      setSecretAccessKey("");
    },
    onError: (e: unknown) => setServerError(errMsg(e)),
  });

  const canSave = accessKeyId.trim().length >= 16 && secretAccessKey.trim().length > 0;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`AWS credentials — ${providerName}`}
      description="Access key + secret are encrypted (AES-256-GCM) and stored directly — no external service required."
      footer={
        <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Btn>
          <Btn
            variant="primary"
            icon="lock"
            loading={save.isPending}
            disabled={!canSave}
            onClick={() => {
              setServerError(null);
              save.mutate();
            }}
          >
            Save
          </Btn>
        </div>
      }
    >
      <div className="col gap-4">
        {cred.data?.hasAwsKeysStored && (
          <div className="row gap-2" style={{ alignItems: "center" }}>
            <Badge tone="ok">keys stored</Badge>
            <Btn
              variant="danger"
              size="sm"
              loading={clear.isPending}
              onClick={() => clear.mutate()}
            >
              Remove keys
            </Btn>
          </div>
        )}

        <Field label="AWS Access Key ID" required hint="e.g. AKIA… / ASIA…">
          <Input
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            placeholder="AKIAIOSFODNN7EXAMPLE"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field
          label="AWS Secret Access Key"
          required
          hint="Stored encrypted; never shown again."
        >
          <Input
            type="password"
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
            placeholder="••••••••••••••••••••••••••••••••"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field label="Default region" hint="Optional — defaults to the provider's region.">
          <Input
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="us-east-1"
          />
        </Field>

        {serverError && (
          <p className="text-sm" style={{ color: "var(--danger, #e5484d)" }}>
            {serverError}
          </p>
        )}
      </div>
    </Modal>
  );
}

function errMsg(e: unknown): string {
  if (
    e &&
    typeof e === "object" &&
    "message" in e &&
    typeof (e as { message: unknown }).message === "string"
  ) {
    return (e as { message: string }).message;
  }
  return "Something went wrong. Please try again.";
}
