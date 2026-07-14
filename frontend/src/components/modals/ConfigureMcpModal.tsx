"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Btn,
  Field,
  Icon,
  Input,
  Modal,
  Select,
  type SelectOption,
  Textarea,
} from "@/components/ui";
import { api } from "@/lib/api/client";

type AuthType = "none" | "oauth" | "credential";
type Status = "ok" | "warn" | "down";

export interface ConfigureMcpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connector: {
    id: string;
    name: string;
    description: string;
    status?: Status | string;
    /** "84.2k / day" — display string from the list endpoint. */
    callsPerDay?: string;
    latency?: string;
  };
}

const AUTH_OPTIONS: SelectOption[] = [
  { value: "none", label: "None (public)" },
  { value: "credential", label: "Credential (API key/token)" },
  { value: "oauth", label: "OAuth 2.0" },
];

const STATUS_OPTIONS: SelectOption[] = [
  { value: "ok", label: "Healthy" },
  { value: "warn", label: "Degraded" },
  { value: "down", label: "Down" },
];

/** Edit an MCP connector's metadata. Credentials are managed separately. */
export function ConfigureMcpModal({ open, onOpenChange, connector }: ConfigureMcpModalProps) {
  const qc = useQueryClient();
  const [name, setName] = useState(connector.name);
  const [description, setDescription] = useState(connector.description);
  const [authType, setAuthType] = useState<AuthType>("none");
  const [status, setStatus] = useState<Status>(
    connector.status === "warn" || connector.status === "down" ? connector.status : "ok",
  );
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(connector.name);
    setDescription(connector.description);
    setStatus(connector.status === "warn" || connector.status === "down" ? connector.status : "ok");
    setServerError(null);
    setConfirmDelete(false);
  }, [open, connector.id, connector.name, connector.description, connector.status]);

  const save = useMutation({
    mutationFn: async () => {
      const patch: Record<string, unknown> = {};
      if (name.trim() && name !== connector.name) patch.name = name.trim();
      if (description.trim() && description !== connector.description)
        patch.description = description.trim();
      if (status !== connector.status) patch.status = status;
      // authType isn't loaded from the list endpoint — only patch when the
      // user explicitly picked a value other than the default "none".
      if (authType !== "none") patch.authType = authType;
      if (Object.keys(patch).length === 0) return { ok: true, noop: true };
      const res = await api.patch<{ ok: boolean; message?: string; code?: string }>(
        `/admin/mcp/${connector.id}`,
        patch,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not save.");
      return res;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["admin", "mcp"] });
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await api.del<{ ok: boolean; message?: string; code?: string }>(
        `/admin/mcp/${connector.id}`,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not delete.");
      return res;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["admin", "mcp"] });
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Configure ${connector.name}`}
      description="Metadata, status and auth. Credentials are managed in the Credentials tab."
      width={620}
      footer={
        confirmDelete ? (
          <>
            <Btn variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Btn>
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
                  setServerError(e instanceof Error ? e.message : "Could not delete.");
                }
              }}
              style={{ background: "var(--danger)", borderColor: "var(--danger)" }}
            >
              Yes, delete
            </Btn>
          </>
        ) : (
          <>
            <Btn variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Btn>
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
        <Field label="Display name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Description" required>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <div className="row gap-3">
          <Field label="Status">
            <Select
              options={STATUS_OPTIONS}
              value={status}
              onValueChange={(v) => setStatus(v as Status)}
              ariaLabel="Status"
            />
          </Field>
          <Field label="Auth method" hint="Switching auth wipes existing credentials on save.">
            <Select
              options={AUTH_OPTIONS}
              value={authType}
              onValueChange={(v) => setAuthType(v as AuthType)}
              ariaLabel="Auth method"
            />
          </Field>
        </div>

        {(connector.callsPerDay || connector.latency) && (
          <div
            className="row gap-3"
            style={{
              padding: "10px 12px",
              background: "var(--surface-2)",
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            <div className="col">
              <span className="faint" style={{ fontSize: 11 }}>
                Avg calls / day
              </span>
              <span className="mono">
                <b>{connector.callsPerDay ?? "—"}</b>
              </span>
            </div>
            <div className="col">
              <span className="faint" style={{ fontSize: 11 }}>
                Avg latency
              </span>
              <span className="mono">
                <b>{connector.latency ?? "—"}</b>
              </span>
            </div>
          </div>
        )}

        {serverError && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {serverError}
          </p>
        )}

        <div
          className="col gap-2"
          style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}
        >
          {confirmDelete ? (
            <p style={{ fontSize: 13, color: "var(--danger)" }}>
              Deleting <b>{connector.name}</b> removes it from every project that connected it.
              Existing audit rows are kept, but credentials are wiped.
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
              Delete this connector…
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
