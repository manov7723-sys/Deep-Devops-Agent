"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { Btn, Field, Icon, Input, Modal } from "@/components/ui";
import { api } from "@/lib/api/client";

/**
 * Provider catalog — what each Connect modal asks the user for. Each
 * `credentials` entry becomes one `IntegrationCredential` row (AES-256-GCM
 * encrypted by `APP_SECRET_KEY` server-side).
 */
export type IntegrationKind =
  "slack" | "pagerduty" | "grafana" | "prometheus" | "datadog" | "sentry";

type CredentialField = {
  key: string;
  label: string;
  placeholder: string;
  hint?: string;
  isSecret?: boolean;
  required?: boolean;
};

type ProviderDef = {
  kind: IntegrationKind;
  name: string;
  icon: string;
  description: string;
  fields: CredentialField[];
};

export const INTEGRATION_PROVIDERS: ProviderDef[] = [
  {
    kind: "slack",
    name: "Slack",
    icon: "chat",
    description: "Send build, deploy, and approval notifications to a Slack channel.",
    fields: [
      {
        key: "webhook_url",
        label: "Incoming webhook URL",
        placeholder: "https://hooks.slack.com/services/T0…",
        hint: "Generated under your Slack app → Incoming Webhooks.",
        isSecret: true,
        required: true,
      },
      { key: "channel", label: "Default channel", placeholder: "#deploys", isSecret: false },
    ],
  },
  {
    kind: "pagerduty",
    name: "PagerDuty",
    icon: "alert",
    description: "Page on-call when deploys fail or production approvals time out.",
    fields: [
      {
        key: "routing_key",
        label: "Integration routing key",
        placeholder: "1abc23de4567890fabcd1234567890ef",
        hint: "From your PagerDuty service → Integrations → Events API v2.",
        isSecret: true,
        required: true,
      },
    ],
  },
  {
    kind: "grafana",
    name: "Grafana",
    icon: "stats",
    description: "Embed dashboards and link runs to traces / metrics.",
    fields: [
      {
        key: "base_url",
        label: "Base URL",
        placeholder: "https://grafana.northwind.io",
        isSecret: false,
        required: true,
      },
      {
        key: "api_key",
        label: "API key",
        placeholder: "glsa_…",
        hint: "Service-account token with Viewer+Datasource read.",
        isSecret: true,
        required: true,
      },
    ],
  },
  {
    kind: "prometheus",
    name: "Prometheus",
    icon: "stats",
    description: "Pull SLO metrics for KPI cards on the Stats tab.",
    fields: [
      {
        key: "endpoint",
        label: "Endpoint URL",
        placeholder: "https://prom.northwind.io/api/v1",
        isSecret: false,
        required: true,
      },
      {
        key: "bearer_token",
        label: "Bearer token",
        placeholder: "optional — leave blank for unauth",
        hint: "Sent as Authorization: Bearer …",
        isSecret: true,
      },
    ],
  },
  {
    kind: "datadog",
    name: "Datadog",
    icon: "stats",
    description: "Mirror approvals & deploys into Datadog events.",
    fields: [
      {
        key: "api_key",
        label: "API key",
        placeholder: "DD_API_KEY",
        isSecret: true,
        required: true,
      },
      {
        key: "app_key",
        label: "App key",
        placeholder: "DD_APP_KEY",
        isSecret: true,
        required: true,
      },
      {
        key: "site",
        label: "Site",
        placeholder: "datadoghq.com",
        isSecret: false,
      },
    ],
  },
  {
    kind: "sentry",
    name: "Sentry",
    icon: "alert",
    description: "Tag releases on Sentry when deploys finish.",
    fields: [
      { key: "org_slug", label: "Org slug", placeholder: "northwind", required: true },
      { key: "project_slug", label: "Project slug", placeholder: "northwind-api", required: true },
      {
        key: "auth_token",
        label: "Auth token",
        placeholder: "sntrys_…",
        hint: "Scoped to `project:releases` + `org:read`.",
        isSecret: true,
        required: true,
      },
    ],
  },
];

export interface ConnectIntegrationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
  /** Optional preset — opens the modal already configured for that provider. */
  preset?: IntegrationKind | null;
}

/** Connect a project-level integration (Slack/PagerDuty/Grafana/etc). */
export function ConnectIntegrationModal({
  open,
  onOpenChange,
  projectSlug,
  preset,
}: ConnectIntegrationModalProps) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<IntegrationKind | null>(preset ?? null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  // Reset when the modal opens — and apply preset if provided.
  useEffect(() => {
    if (open) {
      setPicked(preset ?? null);
      setServerError(null);
      setValues({});
    }
  }, [open, preset]);

  const provider = INTEGRATION_PROVIDERS.find((p) => p.kind === picked) ?? null;

  const create = useMutation({
    mutationFn: async () => {
      if (!provider) throw new Error("Pick a provider first.");
      const missing = provider.fields
        .filter((f) => f.required && !(values[f.key] ?? "").trim())
        .map((f) => f.label);
      if (missing.length > 0) throw new Error(`Missing: ${missing.join(", ")}.`);

      const body = {
        provider: provider.kind,
        name: provider.name,
        icon: provider.icon,
        description: provider.description,
        authType: "credential",
        credentials: provider.fields
          .filter((f) => (values[f.key] ?? "").trim().length > 0)
          .map((f) => ({
            key: f.key,
            value: values[f.key].trim(),
            isSecret: f.isSecret ?? true,
          })),
      };
      const res = await api.post<{ ok: boolean; id?: string; message?: string; code?: string }>(
        `/projects/${projectSlug}/integrations`,
        body,
      );
      if (!res.ok) {
        if (res.code === "duplicate") {
          throw new Error("Already connected. Edit the existing one instead.");
        }
        throw new Error(res.message ?? res.code ?? "Could not connect integration.");
      }
      return res;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["p", projectSlug, "integrations"] });
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={provider ? `Connect ${provider.name}` : "Connect integration"}
      description={
        provider
          ? provider.description
          : "Slack, PagerDuty, Grafana, Prometheus, Datadog, Sentry. Credentials are stored encrypted."
      }
      width={620}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Btn>
          {provider && (
            <Btn
              variant="primary"
              icon="link"
              loading={create.isPending}
              onClick={async () => {
                setServerError(null);
                try {
                  await create.mutateAsync();
                  onOpenChange(false);
                } catch (e) {
                  setServerError(e instanceof Error ? e.message : "Failed.");
                }
              }}
            >
              Connect
            </Btn>
          )}
        </>
      }
    >
      {!provider ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          {INTEGRATION_PROVIDERS.map((p) => (
            <button
              type="button"
              key={p.kind}
              onClick={() => setPicked(p.kind)}
              className="card card-pad col gap-2"
              style={{ textAlign: "left", cursor: "pointer", borderColor: "var(--border)" }}
            >
              <span className="row gap-2" style={{ alignItems: "center" }}>
                <span
                  className="row center"
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: "var(--accent-soft)",
                    color: "var(--accent)",
                    flex: "none",
                  }}
                >
                  <Icon name={p.icon as Parameters<typeof Icon>[0]["name"]} size={15} />
                </span>
                <span style={{ fontWeight: 700 }}>{p.name}</span>
              </span>
              <span className="muted" style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                {p.description}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="col gap-4">
          {provider.fields.map((f) => (
            <Field key={f.key} label={f.label} required={f.required} hint={f.hint}>
              <Input
                type={f.isSecret ? "password" : "text"}
                className={
                  f.key.endsWith("_url") || f.key.endsWith("_key") || f.key.endsWith("_token")
                    ? "mono"
                    : undefined
                }
                placeholder={f.placeholder}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                autoFocus={f === provider.fields[0]}
              />
            </Field>
          ))}

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
            Credentials are encrypted at rest with AES-256-GCM and never sent back over the wire.
          </div>

          {serverError && (
            <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
              {serverError}
            </p>
          )}

          <button
            type="button"
            className="auth-link"
            style={{
              background: "none",
              border: "none",
              padding: 0,
              fontSize: 12.5,
              textAlign: "left",
              cursor: "pointer",
            }}
            onClick={() => {
              setPicked(null);
              setValues({});
              setServerError(null);
            }}
          >
            ← Pick a different provider
          </button>
        </div>
      )}
    </Modal>
  );
}
