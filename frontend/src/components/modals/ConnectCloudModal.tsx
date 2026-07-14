"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Btn, Field, Icon, Input, Modal } from "@/components/ui";
import { api } from "@/lib/api/client";
import { AwsTrustPolicyHelp } from "@/components/domain/AwsTrustPolicyHelp";
import { useConnectAwsAccount } from "@/hooks/queries/connectivity";

export interface ConnectCloudModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the modal also offers to bind the new provider to envs of this project. */
  projectSlug?: string;
  /** Pre-select a provider tab when the modal opens (e.g. the project's chosen cloud). */
  initialKind?: "aws" | "gcp" | "azure" | "proxmox";
  /** Lock the modal to ONE cloud (hides the provider chips). Used for cloud-specific projects. */
  lockedKind?: "aws" | "gcp" | "azure" | "proxmox" | null;
}

type CloudKind = "aws" | "gcp" | "azure" | "proxmox";

const KIND_OPTIONS: Array<{ kind: CloudKind; label: string; hint: string }> = [
  { kind: "aws", label: "AWS", hint: "Cross-account IAM role + STS ExternalId" },
  { kind: "gcp", label: "GCP", hint: "Sign in with Google (OAuth)" },
  { kind: "azure", label: "Azure", hint: "Subscription + Service principal" },
  { kind: "proxmox", label: "Proxmox", hint: "Self-hosted Proxmox VE + API token" },
];

const REGION_DEFAULTS: Record<CloudKind, string> = {
  aws: "us-east-1",
  gcp: "us-central1",
  azure: "eastus",
  proxmox: "pve", // Proxmox has no region — this is the default node name.
};

const REGION_HINT: Record<CloudKind, string> = {
  aws: "AWS region (e.g. us-east-1, eu-west-2).",
  gcp: "GCP region or multi-region (e.g. us-central1, europe-west1).",
  azure: "Azure region (e.g. eastus, westeurope).",
  proxmox: "Default Proxmox node name (e.g. pve) — where new VMs land unless overridden.",
};

/**
 * Each NON-AWS provider has its own list of credential fields. (AWS is handled
 * separately via the cross-account STS flow — see the `aws` branch below.) The
 * `schemaColumn` says which CloudProvider column the value writes to.
 */
type FieldSpec = {
  schemaColumn: "name" | "accountRef" | "accountId" | "roleArn" | "externalId" | "region";
  label: string;
  placeholder: string;
  hint?: string;
  mono?: boolean;
  secret?: boolean;
  required?: boolean;
};

const PROVIDER_FIELDS: Record<"gcp" | "azure" | "proxmox", { fields: FieldSpec[] }> = {
  proxmox: {
    fields: [
      {
        schemaColumn: "accountRef",
        label: "Proxmox host URL",
        placeholder: "https://pve.example.com:8006",
        hint: "The Proxmox VE API endpoint (host + port 8006).",
        mono: true,
        required: true,
      },
      {
        schemaColumn: "roleArn",
        label: "API token ID",
        placeholder: "root@pam!deepagent",
        hint: 'The token ID, formatted "user@realm!tokenname".',
        mono: true,
        required: true,
      },
      {
        schemaColumn: "externalId",
        label: "API token secret",
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        hint: "Shown once when you created the token. Encrypted at rest (AES-256-GCM).",
        mono: true,
        secret: true,
        required: true,
      },
    ],
  },
  gcp: {
    fields: [
      {
        schemaColumn: "accountRef",
        label: "GCP Project ID",
        placeholder: "northwind-prod-461298",
        hint: "Project ID (NOT the numeric project number).",
        mono: true,
        required: true,
      },
      {
        schemaColumn: "accountId",
        label: "Project number",
        placeholder: "461298145672",
        hint: "Numeric — visible at the top of the GCP console dashboard.",
        mono: true,
      },
      {
        schemaColumn: "roleArn",
        label: "Service account email",
        placeholder: "deep-agent@northwind-prod.iam.gserviceaccount.com",
        hint: "Workload-identity service account Deep Agent impersonates.",
        mono: true,
        required: true,
      },
      {
        schemaColumn: "externalId",
        label: "Workload-identity pool",
        placeholder:
          "projects/461298145672/locations/global/workloadIdentityPools/dda-pool/providers/dda",
        hint: "Optional — federated pool resource path.",
        mono: true,
        secret: true,
      },
    ],
  },
  azure: {
    fields: [
      {
        schemaColumn: "accountRef",
        label: "Subscription ID",
        placeholder: "00000000-0000-0000-0000-000000000000",
        hint: "Found in Azure Portal → Subscriptions.",
        mono: true,
        required: true,
      },
      {
        schemaColumn: "accountId",
        label: "Tenant ID",
        placeholder: "00000000-0000-0000-0000-000000000000",
        hint: "Microsoft Entra (Azure AD) tenant.",
        mono: true,
        required: true,
      },
      {
        schemaColumn: "roleArn",
        label: "App (Client) ID",
        placeholder: "00000000-0000-0000-0000-000000000000",
        hint: "Service principal / app registration that Deep Agent uses.",
        mono: true,
        required: true,
      },
      {
        schemaColumn: "externalId",
        label: "Client secret",
        placeholder: "value from App registration → Certificates & secrets",
        hint: "Encrypted at rest with AES-256-GCM. Rotate via Azure Portal anytime.",
        mono: true,
        secret: true,
        required: true,
      },
    ],
  },
};

type EnvRow = {
  id: string;
  key: string;
  name: string;
  isProduction: boolean;
  cloudProviderId: string | null;
};

export function ConnectCloudModal({
  open,
  onOpenChange,
  projectSlug,
  initialKind,
  lockedKind,
}: ConnectCloudModalProps) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<CloudKind>("aws");
  const [name, setName] = useState("");
  const [region, setRegion] = useState(REGION_DEFAULTS.aws);
  const [values, setValues] = useState<Partial<Record<FieldSpec["schemaColumn"], string>>>({});
  // AWS-only: the cross-account role ARN. ExternalId is shown (not typed) by
  // AwsTrustPolicyHelp and derived server-side at connect time.
  const [awsRoleArn, setAwsRoleArn] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bindEnvs, setBindEnvs] = useState<Set<string>>(new Set());
  const [azureBusy, setAzureBusy] = useState(false);

  // Reset everything when the modal opens.
  useEffect(() => {
    if (!open) return;
    setKind(lockedKind ?? initialKind ?? "aws");
    setName("");
    setRegion(REGION_DEFAULTS.aws);
    setValues({});
    setAwsRoleArn("");
    setBindEnvs(new Set());
    setServerError(null);
    setNotice(null);
  }, [open]);

  const envsQuery = useQuery<EnvRow[]>({
    queryKey: ["p", projectSlug, "envs"],
    queryFn: () => api.get<EnvRow[]>(`/projects/${projectSlug}/envs`),
    enabled: open && !!projectSlug,
    staleTime: 30_000,
  });

  const connectAws = useConnectAwsAccount();

  // GCP/Azure go straight to /cloud-providers (their creds live on the row).
  const createOther = useMutation({
    mutationFn: async (body: {
      kind: CloudKind;
      name: string;
      accountRef: string;
      accountId?: string;
      region: string;
      roleArn?: string;
      externalId?: string;
      projectSlug?: string;
    }) => {
      const res = await api.post<{
        ok: boolean;
        provider?: { id: string };
        message?: string;
        code?: string;
      }>("/cloud-providers", body);
      if (!res.ok || !res.provider)
        throw new Error(res.message ?? res.code ?? "Could not connect provider.");
      return res.provider;
    },
  });

  const isAws = kind === "aws";
  const isAzure = kind === "azure";
  const isGcp = kind === "gcp";
  const isOAuth = isAzure || isGcp; // both connect via a "Sign in with …" popup
  const pending = connectAws.isPending || createOther.isPending || azureBusy;

  // Azure/GCP "Sign in with …" — opens the OAuth start route in a popup. The
  // callback creates the provider and signals back (postMessage + localStorage).
  function openOAuthPopup(provider: "azure" | "gcp") {
    setServerError(null);
    const w = 600,
      h = 720;
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
    const url = `/api/v1/cloud-providers/${provider}/oauth/start?popup=1${projectSlug ? `&projectSlug=${encodeURIComponent(projectSlug)}` : ""}`;
    const popup = window.open(
      url,
      `dda_${provider}_oauth`,
      `width=${w},height=${h},left=${left},top=${top}`,
    );
    if (!popup) {
      window.location.href = url.replace(/[?&]popup=1/, (m) => (m[0] === "?" ? "?" : ""));
      return;
    }
    setAzureBusy(true);
    const timer = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(timer);
        setAzureBusy(false);
        qc.invalidateQueries({ queryKey: ["cloud-providers"] });
      }
    }, 800);
  }

  useEffect(() => {
    if (!open) return;
    const SOURCES = ["dda-azure-oauth", "dda-gcp-oauth"];
    function handle(d: { source?: string; status?: string; detail?: string } | null) {
      if (!d || !SOURCES.includes(d.source ?? "")) return;
      setAzureBusy(false);
      if (d.status === "connected") {
        qc.invalidateQueries({ queryKey: ["cloud-providers"] });
        if (projectSlug) qc.invalidateQueries({ queryKey: ["p", projectSlug] });
        onOpenChange(false);
      } else {
        setServerError(d.detail || "Cloud sign-in failed.");
      }
    }
    function onMsg(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      handle(e.data as Parameters<typeof handle>[0]);
    }
    // localStorage 'storage' event = COOP-proof fallback (Next 16 can sever
    // window.opener, dropping postMessage). The callbacks write a result key.
    function onStorage(e: StorageEvent) {
      if ((e.key !== "dda_azure_oauth_result" && e.key !== "dda_gcp_oauth_result") || !e.newValue)
        return;
      try {
        handle(JSON.parse(e.newValue.split("|")[0]));
      } catch {
        /* ignore malformed */
      }
    }
    window.addEventListener("message", onMsg);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("message", onMsg);
      window.removeEventListener("storage", onStorage);
    };
  }, [open, projectSlug, qc, onOpenChange]);

  function setKindAndReset(k: CloudKind) {
    setKind(k);
    // Drop any values from the prior provider — same schema column can mean
    // very different things between providers.
    setValues({});
    setAwsRoleArn("");
    setRegion(REGION_DEFAULTS[k]);
    setServerError(null);
    setNotice(null);
  }

  /** Bind the freshly-created provider to whichever envs the user ticked. */
  async function bindToEnvs(providerId: string) {
    if (!projectSlug || bindEnvs.size === 0) return;
    const targets = (envsQuery.data ?? []).filter((e) => bindEnvs.has(e.id));
    for (const env of targets) {
      await api
        .patch<{ ok: boolean }>(`/projects/${projectSlug}/envs/${env.key}`, {
          cloudProviderId: providerId,
        })
        .catch(() => {});
    }
  }

  async function submit() {
    setServerError(null);
    setNotice(null);

    if (isAws) {
      // Cross-account STS flow: user supplies only the role ARN. The server
      // derives the ExternalId and assumes the role to verify it.
      if (!awsRoleArn.trim()) {
        setServerError("IAM role ARN is required.");
        return;
      }
      try {
        const res = await connectAws.mutateAsync({
          roleArn: awsRoleArn.trim(),
          region: region.trim() || REGION_DEFAULTS.aws,
          accountRef: name.trim() || undefined,
          projectSlug,
        });
        await bindToEnvs(res.provider!.id);
        await qc.invalidateQueries({ queryKey: ["cloud-providers"] });
        if (projectSlug) await qc.invalidateQueries({ queryKey: ["p", projectSlug] });
        if (res.verified) {
          onOpenChange(false);
        } else {
          // Saved but couldn't verify (e.g. aws CLI / platform creds missing).
          // Keep the modal open with a heads-up rather than failing outright.
          setNotice(
            `Account saved, but the role couldn't be verified yet${res.verifyMessage ? ` — ${res.verifyMessage}` : ""}.`,
          );
        }
      } catch (e) {
        setServerError(e instanceof Error ? e.message : "Could not connect AWS account.");
      }
      return;
    }

    // GCP / Azure — validate required field-spec fields, then create.
    const spec = PROVIDER_FIELDS[kind];
    const missing = spec.fields
      .filter((f) => f.required && !(values[f.schemaColumn] ?? "").trim())
      .map((f) => f.label);
    if (missing.length > 0) {
      setServerError(
        `Missing required field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`,
      );
      return;
    }
    if (!region.trim()) {
      setServerError("Region is required.");
      return;
    }
    try {
      const provider = await createOther.mutateAsync({
        kind,
        name: name.trim() || `${kind.toUpperCase()} (${region.trim()})`,
        accountRef: values.accountRef?.trim() ?? "",
        accountId: values.accountId?.trim() || undefined,
        region: region.trim(),
        roleArn: values.roleArn?.trim() || undefined,
        externalId: values.externalId?.trim() || undefined,
        projectSlug,
      });
      await bindToEnvs(provider.id);
      await qc.invalidateQueries({ queryKey: ["cloud-providers"] });
      if (projectSlug) await qc.invalidateQueries({ queryKey: ["p", projectSlug] });
      onOpenChange(false);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Could not connect provider.");
    }
  }

  function toggleEnv(id: string) {
    setBindEnvs((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const helpCopy = useMemo<Record<"gcp" | "azure" | "proxmox", string>>(
    () => ({
      gcp: "Deep Agent impersonates a service account. Use workload identity federation if you can — no long-lived keys.",
      azure:
        "Deep Agent signs in as a service principal in your Entra tenant. The client secret is encrypted at rest.",
      proxmox:
        "Deep Agent connects to your Proxmox VE server with a scoped API token (encrypted at rest) and uses it to create VMs via Terraform.",
    }),
    [],
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Connect a cloud provider"
      description={
        kind === "aws"
          ? "AWS — cross-account IAM role + STS ExternalId. No long-lived keys are stored."
          : kind === "gcp"
            ? "GCP — sign in with Google. An encrypted refresh token is stored; no service-account key to manage."
            : kind === "azure"
              ? "Azure — sign in with Microsoft. An encrypted refresh token is stored; no secrets to manage."
              : "Proxmox — connect a self-hosted Proxmox VE server with an API token. The token secret is encrypted at rest."
      }
      width={620}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Btn>
          {!isOAuth && (
            <Btn variant="primary" icon="link" loading={pending} onClick={submit}>
              Connect
            </Btn>
          )}
        </>
      }
    >
      <div className="col gap-4">
        {/* Provider chips — hidden when the modal is locked to one cloud
            (cloud-specific project), so only that provider's setup shows. */}
        <div className="row gap-2 wrap" style={lockedKind ? { display: "none" } : undefined}>
          {KIND_OPTIONS.map((c) => (
            <button
              type="button"
              key={c.kind}
              className={`chip ${kind === c.kind ? "active" : ""}`}
              style={{ height: 38 }}
              onClick={() => setKindAndReset(c.kind)}
              title={c.hint}
            >
              <Icon name="cloud" size={15} />
              {c.label}
            </button>
          ))}
        </div>

        {!isOAuth && (
          <Field label="Display name" hint="Shown on the project Cloud tab.">
            <Input
              placeholder={`${kind.toUpperCase()} prod`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        )}

        {isAws ? (
          /* AWS — cross-account STS AssumeRole. ExternalId + trust policy are
             shown (read-only) by AwsTrustPolicyHelp; the user pastes the role ARN. */
          <div className="col gap-4">
            <AwsTrustPolicyHelp enabled={open && isAws} />
            <Field
              label="IAM role ARN"
              required
              hint="The role you created with the trust policy above. Deep Agent assumes it via STS."
            >
              <Input
                className="mono"
                placeholder="arn:aws:iam::461298145672:role/deep-agent"
                value={awsRoleArn}
                onChange={(e) => setAwsRoleArn(e.target.value)}
              />
            </Field>
          </div>
        ) : isAzure ? (
          /* Azure — interactive "Sign in with Microsoft" (OAuth + PKCE). The
             popup completes the connection; no fields to fill here. */
          <div className="col gap-3">
            <div className="row gap-2 dda-wizard-iam-note">
              <Icon name="shield" size={16} style={{ flex: "none" }} />
              <span style={{ fontSize: 12.5 }}>
                Connect with your Microsoft account — pick the account, approve access, and Deep
                Agent stores an encrypted refresh token (no client secret to manage).
              </span>
            </div>
            <Btn
              variant="primary"
              icon="cloud"
              loading={azureBusy}
              onClick={() => openOAuthPopup("azure")}
            >
              Sign in with Microsoft
            </Btn>
          </div>
        ) : isGcp ? (
          /* GCP — interactive "Sign in with Google" (OAuth + PKCE). The popup
             completes the connection; no fields to fill here. */
          <div className="col gap-3">
            <div className="row gap-2 dda-wizard-iam-note">
              <Icon name="shield" size={16} style={{ flex: "none" }} />
              <span style={{ fontSize: 12.5 }}>
                Connect with your Google account — pick the account, approve cloud-platform access,
                and Deep Agent stores an encrypted refresh token (no service-account key to manage).
              </span>
            </div>
            <Btn
              variant="primary"
              icon="cloud"
              loading={azureBusy}
              onClick={() => openOAuthPopup("gcp")}
            >
              Sign in with Google
            </Btn>
          </div>
        ) : (
          /* Proxmox — self-hosted PVE via API token. Credential fields written
             to the CloudProvider row (endpoint/token id/token secret); the
             connect route validates against /api2/json/version + encrypts. */
          <div className="col gap-4">
            <div className="row gap-2 dda-wizard-iam-note">
              <Icon name="shield" size={16} style={{ flex: "none" }} />
              <span style={{ fontSize: 12.5 }}>
                Connect a self-hosted Proxmox VE server with an API token. The token secret is
                encrypted at rest; DeepAgent uses it to create VMs via Terraform.
              </span>
            </div>
            {PROVIDER_FIELDS.proxmox.fields.map((f) => (
              <Field key={f.schemaColumn} label={f.label} required={f.required} hint={f.hint}>
                <Input
                  className={f.mono ? "mono" : undefined}
                  type={f.secret ? "password" : "text"}
                  placeholder={f.placeholder}
                  value={values[f.schemaColumn] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.schemaColumn]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
        )}

        {!isOAuth && (
          <Field label="Default region" required hint={REGION_HINT[kind]}>
            <Input value={region} onChange={(e) => setRegion(e.target.value)} />
          </Field>
        )}

        {projectSlug && (
          <Field
            label="Assign to environments"
            hint={
              envsQuery.data && envsQuery.data.length === 0
                ? "No envs in this project yet — create one first on the Environments tab."
                : "Selected envs will route their deployments to this provider."
            }
          >
            {envsQuery.isLoading ? (
              <span className="muted" style={{ fontSize: 13 }}>
                Loading…
              </span>
            ) : envsQuery.data && envsQuery.data.length > 0 ? (
              <div className="row gap-2 wrap">
                {envsQuery.data.map((env) => {
                  const on = bindEnvs.has(env.id);
                  const tone = env.isProduction ? "ok" : "info";
                  const alreadyBound = !!env.cloudProviderId;
                  return (
                    <button
                      type="button"
                      key={env.id}
                      className={`chip ${on ? "active" : ""}`}
                      onClick={() => toggleEnv(env.id)}
                      title={
                        alreadyBound
                          ? "Already bound to another provider — this will replace it."
                          : ""
                      }
                    >
                      <span
                        className={`dot ${tone}`}
                        style={{ boxShadow: "none", width: 6, height: 6 }}
                      />
                      {env.name}
                      {alreadyBound && (
                        <span className="faint" style={{ marginLeft: 6, fontSize: 11 }}>
                          · bound
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </Field>
        )}

        {!isAws && (
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
            {helpCopy[kind]}
          </div>
        )}

        {notice && (
          <p style={{ fontSize: 12.5, color: "var(--warn, #b8860b)" }} role="status">
            {notice}
          </p>
        )}
        {serverError && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {serverError}
          </p>
        )}
      </div>
    </Modal>
  );
}
