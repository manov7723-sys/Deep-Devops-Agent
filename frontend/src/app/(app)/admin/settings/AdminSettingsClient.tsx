"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { Route } from "next";
import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Block,
  Btn,
  DataTable,
  Field,
  Icon,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Modal,
  PageHead,
  StatusDot,
  Textarea,
  Toggle,
} from "@/components/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import {
  usePlatformSettings,
  usePlatformSettingsPatch,
  useAdminOAuthConfigs,
  useUpsertAdminOAuthConfig,
  useToggleAdminOAuthConfig,
  useClearAdminOAuthConfig,
  type OAuthConfigRow,
} from "@/hooks/queries/admin-ops";
import type { SeedEnvVar, SeedSystemComponent } from "@/lib/legacy-types";

type Tab = "branding" | "oauth" | "env" | "email" | "status";

const STATUS_TONE = { ok: "ok", warn: "warn", danger: "danger" } as const;

export function AdminSettingsClient() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tab = (sp.get("tab") as Tab | null) ?? "branding";

  function setTab(next: Tab) {
    const p = new URLSearchParams(sp);
    p.set("tab", next);
    const q = p.toString();
    router.replace((q ? `${pathname}?${q}` : pathname) as Route);
  }

  return (
    <div className="col gap-5">
      <PageHead
        title="Platform settings"
        sub="Branding, environment variables, email and system status."
        tabs={[
          { value: "branding", label: "Branding" },
          { value: "oauth", label: "OAuth providers" },
          { value: "env", label: "Environment vars" },
          { value: "email", label: "Email" },
          { value: "status", label: "System status" },
        ]}
        tabValue={tab}
        onTabChange={(v) => setTab(v as Tab)}
      />

      {tab === "branding" && <BrandingTab />}
      {tab === "oauth" && <OAuthProvidersTab />}
      {tab === "env" && <EnvVarsTab />}
      {tab === "email" && <EmailTab />}
      {tab === "status" && <SystemStatusTab />}
    </div>
  );
}

type BrandAsset = {
  key: string;
  label: string;
  hint: string;
  url: string | null;
  localFallback: string;
  hasUpload: boolean;
};

function BrandingTab() {
  const { data: settings } = usePlatformSettings();
  const patch = usePlatformSettingsPatch();
  const [siteTitle, setSiteTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [uploadTarget, setUploadTarget] = useState<BrandAsset | null>(null);

  useEffect(() => {
    if (!settings) return;
    setSiteTitle(settings.branding.siteTitle);
    setMetaDescription(settings.branding.metaDescription);
  }, [settings]);

  if (!settings) {
    return (
      <div style={{ maxWidth: 720 }}>
        <Block><Block.Loading /></Block>
      </div>
    );
  }

  return (
    <div className="col gap-4" style={{ maxWidth: 720 }}>
      <Block>
        <Block.Header>
          <Block.Title>Brand assets</Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="col gap-4">
            {(settings.branding.assets as unknown as BrandAsset[]).map((b) => {
              const preview = b.url ?? b.localFallback;
              return (
                <div key={b.key} className="row between gap-3">
                  <div className="row gap-3">
                    <div
                      className="dda-brand-asset"
                      role="img"
                      aria-label={`${b.label} preview`}
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: 10,
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                        display: "grid",
                        placeItems: "center",
                        overflow: "hidden",
                      }}
                    >
                      {preview ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={preview}
                          alt={b.label}
                          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                        />
                      ) : (
                        <span className="faint" style={{ fontSize: 11 }}>{b.label.split(" ")[0]}</span>
                      )}
                    </div>
                    <div className="col" style={{ lineHeight: 1.35 }}>
                      <span style={{ fontWeight: 600 }}>
                        {b.label}
                        {!b.hasUpload && (
                          <span
                            className="faint"
                            style={{ fontSize: 11, marginLeft: 6, fontWeight: 400 }}
                          >
                            (default)
                          </span>
                        )}
                      </span>
                      <span className="faint" style={{ fontSize: 12 }}>{b.hint}</span>
                    </div>
                  </div>
                  <Btn
                    size="sm"
                    variant="outline"
                    icon={b.hasUpload ? "edit" : "plus"}
                    aria-label={`Upload ${b.label}`}
                    onClick={() => setUploadTarget(b)}
                  >
                    {b.hasUpload ? "Replace" : "Upload"}
                  </Btn>
                </div>
              );
            })}
          </div>
        </Block.Body>
      </Block>
      {uploadTarget && (
        <BrandAssetUploadModal
          open={!!uploadTarget}
          onOpenChange={(o) => { if (!o) setUploadTarget(null); }}
          asset={uploadTarget}
        />
      )}
      <Block>
        <Block.Header>
          <Block.Title>Metadata</Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="col gap-4">
            <Field label="Site title">
              <Input value={siteTitle} onChange={(e) => setSiteTitle(e.target.value)} />
            </Field>
            <Field label="Meta description">
              <Textarea rows={2} value={metaDescription} onChange={(e) => setMetaDescription(e.target.value)} />
            </Field>
            <div className="row">
              <Btn
                variant="primary"
                icon="check"
                loading={patch.isPending}
                onClick={() => patch.mutate({ siteTitle, metaDescription })}
              >
                Save
              </Btn>
            </div>
          </div>
        </Block.Body>
      </Block>
    </div>
  );
}

function EnvVarsTab() {
  const { data: settings, isLoading } = usePlatformSettings();
  const envVars = settings?.envVars ?? [];

  const columns = useMemo<ColumnDef<SeedEnvVar>[]>(
    () => [
      {
        id: "key",
        header: "Key",
        cell: ({ row }) => (
          <span className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>{row.original.key}</span>
        ),
      },
      {
        id: "value",
        header: "Value",
        cell: ({ row }) => (
          <span className="dda-envvar-mask">
            <span className="sr-only">Masked secret: </span>
            {row.original.value}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <StatusDot tone={STATUS_TONE[row.original.status]} label={row.original.statusLabel} />
        ),
      },
      {
        id: "actions",
        header: () => <span className="hide-sm">Actions</span>,
        cell: ({ row }) => (
          <Menu
            trigger={
              <Btn
                variant="ghost"
                size="icon"
                aria-label={`Actions for ${row.original.key}`}
              >
                <Icon name="more" size={16} />
              </Btn>
            }
          >
            <MenuItem icon="eye">Reveal</MenuItem>
            <MenuItem icon="edit">Edit</MenuItem>
            <MenuSeparator />
            <MenuItem icon="trash" danger>
              Delete
            </MenuItem>
          </Menu>
        ),
      },
    ],
    [],
  );

  return (
    <Block>
      <Block.Header>
        <Block.Title>Environment variables</Block.Title>
        <Block.Actions>
          <Btn size="sm" variant="primary" icon="plus">
            Add variable
          </Btn>
        </Block.Actions>
      </Block.Header>
      <DataTable
        data={envVars}
        columns={columns}
        loading={isLoading}
        rowKey={(v) => v.id}
        emptyTitle="No environment variables"
        emptyIcon="key"
      />
    </Block>
  );
}

function EmailTab() {
  const { data: settings } = usePlatformSettings();
  const patch = usePlatformSettingsPatch();
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("");
  const [fromAddress, setFromAddress] = useState("");

  useEffect(() => {
    if (!settings) return;
    setSmtpHost(settings.email.smtpHost);
    setSmtpPort(settings.email.smtpPort);
    setFromAddress(settings.email.fromAddress);
  }, [settings]);

  if (!settings) {
    return (
      <div style={{ maxWidth: 640 }}>
        <Block><Block.Loading /></Block>
      </div>
    );
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title>Email configuration</Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-4" style={{ maxWidth: 600 }}>
          <div className="row gap-3 wrap">
            <div className="grow" style={{ minWidth: 180 }}>
              <Field label="SMTP host">
                <Input className="mono" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
              </Field>
            </div>
            <div style={{ width: 120 }}>
              <Field label="Port">
                <Input className="mono" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
              </Field>
            </div>
          </div>
          <Field label="From address">
            <Input value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} />
          </Field>
          <div className="dda-email-ok-banner">
            <Icon name="check" size={16} />
            Connection verified · last test passed {settings.email.verifiedAt}
          </div>
          <div className="row gap-2">
            <Btn variant="outline" icon="mail">
              Send test email
            </Btn>
            <Btn
              variant="primary"
              icon="check"
              loading={patch.isPending}
              onClick={() => patch.mutate({ smtpHost, smtpPort, fromAddress })}
            >
              Save
            </Btn>
          </div>
        </div>
      </Block.Body>
    </Block>
  );
}

function SystemStatusTab() {
  const { data: settings } = usePlatformSettings();
  const components: SeedSystemComponent[] = settings?.systemStatus ?? [];

  return (
    <Block>
      <Block.Header>
        <Block.Title>System status</Block.Title>
      </Block.Header>
      {settings ? (
        <ul className="col" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="System components">
          {components.map((s) => (
            <li
              key={s.id}
              className="row between gap-3"
              style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-soft)" }}
            >
              <div className="row gap-3">
                <StatusDot
                  tone={STATUS_TONE[s.status]}
                  pulse={s.status === "ok"}
                  label={s.status === "ok" ? "Operational" : s.status === "warn" ? "Degraded" : "Down"}
                />
                <span style={{ fontWeight: 600 }}>{s.name}</span>
              </div>
              <span className="faint" style={{ fontSize: 12.5 }}>{s.note}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Block.Loading />
      )}
    </Block>
  );
}

function BrandAssetUploadModal({
  open,
  onOpenChange,
  asset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: BrandAsset;
}) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(asset.url ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUrl(asset.url ?? "");
    setError(null);
  }, [open, asset.url]);

  const save = useMutation({
    mutationFn: async (nextUrl: string | null) => {
      const res = await api.post<{ ok: boolean; message?: string; code?: string }>(
        "/admin/settings/assets",
        { key: asset.key, url: nextUrl },
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not save.");
      return res;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
  });

  const submit = async (nextUrl: string | null) => {
    setError(null);
    try {
      await save.mutateAsync(nextUrl);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Upload ${asset.label}`}
      description="Paste a public URL to the image. Leave it as-is and reset to use the built-in default."
      width={520}
      footer={
        <>
          {asset.hasUpload && (
            <Btn
              variant="ghost"
              icon="x"
              loading={save.isPending}
              onClick={() => submit(null)}
            >
              Reset to default
            </Btn>
          )}
          <div style={{ flex: 1 }} />
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon="check"
            loading={save.isPending}
            disabled={!url.trim()}
            onClick={() => submit(url.trim())}
          >
            Save URL
          </Btn>
        </>
      }
    >
      <div className="col gap-4">
        <Field label="Image URL" required hint="Must be a publicly reachable https:// URL.">
          <Input
            type="url"
            placeholder="https://cdn.example.com/brand/logo.svg"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <div
          className="row gap-3"
          style={{
            padding: 12,
            background: "var(--surface-2)",
            borderRadius: 8,
            alignItems: "center",
          }}
        >
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 10,
              background: "var(--surface-1)",
              border: "1px solid var(--border)",
              display: "grid",
              placeItems: "center",
              overflow: "hidden",
              flex: "none",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url.trim() || asset.localFallback}
              alt="preview"
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            />
          </div>
          <div className="col" style={{ fontSize: 12 }}>
            <span style={{ fontWeight: 600 }}>Preview</span>
            <span className="faint">
              {url.trim() ? "Live preview of the URL." : "Using the built-in default."}
            </span>
          </div>
        </div>
        {error && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ─────────────── OAuth providers tab ─────────────── */

type OAuthProviderId = "github" | "google";

const OAUTH_PROVIDER_META: Record<
  OAuthProviderId,
  { label: string; icon: "github" | "user"; helpUrl: string; redirectHint: string }
> = {
  github: {
    label: "GitHub",
    icon: "github",
    helpUrl: "https://github.com/settings/developers",
    redirectHint: "/api/v1/auth/oauth/github/callback",
  },
  google: {
    label: "Google",
    icon: "user",
    helpUrl: "https://console.cloud.google.com/apis/credentials",
    redirectHint: "/api/v1/auth/oauth/google/callback",
  },
};

function OAuthProvidersTab() {
  const { data: configs, isLoading } = useAdminOAuthConfigs();
  const [editing, setEditing] = useState<OAuthProviderId | null>(null);

  const byProvider = new Map<OAuthProviderId, OAuthConfigRow>(
    (configs ?? []).map((c) => [c.provider, c]),
  );

  return (
    <div className="col gap-4" style={{ maxWidth: 760 }}>
      <Block>
        <Block.Header>
          <Block.Title sub="Client ID and secret used for social sign-in. Secrets are stored encrypted; rotating here takes effect on the next sign-in attempt — no redeploy needed.">
            OAuth providers
          </Block.Title>
        </Block.Header>
        {isLoading ? (
          <Block.Loading />
        ) : (
          <div className="col">
            {(Object.keys(OAUTH_PROVIDER_META) as OAuthProviderId[]).map((id) => (
              <OAuthProviderRow
                key={id}
                providerId={id}
                config={byProvider.get(id)}
                onEdit={() => setEditing(id)}
              />
            ))}
          </div>
        )}
      </Block>

      {editing && (
        <OAuthProviderModal
          open={!!editing}
          onOpenChange={(o) => { if (!o) setEditing(null); }}
          providerId={editing}
          existing={byProvider.get(editing)}
        />
      )}
    </div>
  );
}

function OAuthProviderRow({
  providerId,
  config,
  onEdit,
}: {
  providerId: OAuthProviderId;
  config: OAuthConfigRow | undefined;
  onEdit: () => void;
}) {
  const meta = OAUTH_PROVIDER_META[providerId];
  const toggle = useToggleAdminOAuthConfig();
  const clear = useClearAdminOAuthConfig();
  const configured = !!config;

  return (
    <div
      className="row between gap-3"
      style={{
        padding: "16px 18px",
        borderBottom: "1px solid var(--border-soft)",
      }}
    >
      <div className="row gap-3" style={{ minWidth: 0 }}>
        <span
          className="row center"
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: "var(--surface-2)",
            color: "var(--text)",
            flex: "none",
          }}
        >
          <Icon name={meta.icon} size={18} />
        </span>
        <div className="col" style={{ lineHeight: 1.35, minWidth: 0 }}>
          <span className="row gap-2" style={{ fontWeight: 700 }}>
            {meta.label}
            {configured ? (
              <StatusDot tone={config!.enabled ? "ok" : "warn"} />
            ) : (
              <StatusDot tone="danger" />
            )}
          </span>
          {configured ? (
            <span className="faint mono" style={{ fontSize: 12 }}>
              client {config!.clientId.slice(0, 8)}… · secret {config!.secretMask || "—"}
              {!config!.enabled ? " · disabled" : ""}
            </span>
          ) : (
            <span className="faint" style={{ fontSize: 12 }}>
              Not configured. Falls back to environment variables if present.
            </span>
          )}
        </div>
      </div>
      <div className="row gap-2" style={{ alignItems: "center" }}>
        {configured && (
          <Toggle
            checked={config!.enabled}
            onCheckedChange={(v) => toggle.mutate({ provider: providerId, enabled: v })}
            ariaLabel={`${meta.label} enabled`}
          />
        )}
        <Btn size="sm" variant="outline" icon="edit" onClick={onEdit}>
          {configured ? "Update" : "Configure"}
        </Btn>
        {configured && (
          <Btn
            size="sm"
            variant="ghost"
            icon="x"
            loading={clear.isPending}
            onClick={() => {
              if (confirm(`Clear ${meta.label} OAuth config? Falls back to env vars after this.`)) {
                clear.mutate(providerId);
              }
            }}
            aria-label="Clear configuration"
          />
        )}
      </div>
    </div>
  );
}

function OAuthProviderModal({
  open,
  onOpenChange,
  providerId,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: OAuthProviderId;
  existing: OAuthConfigRow | undefined;
}) {
  const meta = OAUTH_PROVIDER_META[providerId];
  const upsert = useUpsertAdminOAuthConfig();
  const [clientId, setClientId] = useState(existing?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setClientId(existing?.clientId ?? "");
    setClientSecret("");
    setError(null);
  }, [open, existing?.clientId]);

  const isUpdate = !!existing;
  const canSubmit = clientId.trim().length > 0 && (isUpdate || clientSecret.trim().length > 0);

  async function submit() {
    setError(null);
    try {
      await upsert.mutateAsync({
        provider: providerId,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
      });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`${isUpdate ? "Update" : "Configure"} ${meta.label} OAuth`}
      description={`Create an OAuth app at the provider, then paste the credentials here. Callback URL: ${meta.redirectHint}`}
      width={560}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)} disabled={upsert.isPending}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon="check"
            loading={upsert.isPending}
            disabled={!canSubmit}
            onClick={submit}
          >
            Save credentials
          </Btn>
        </>
      }
    >
      <div className="col gap-4">
        <div
          style={{
            padding: "8px 12px",
            background: "var(--surface-2)",
            borderRadius: 8,
            fontSize: 12,
          }}
        >
          <span className="faint">Need credentials?</span>{" "}
          <a
            href={meta.helpUrl}
            target="_blank"
            rel="noreferrer"
            className="auth-link"
            style={{ fontSize: 12 }}
          >
            {meta.helpUrl}
          </a>
        </div>
        <Field label="Client ID" required>
          <Input
            className="mono"
            placeholder="Iv1.abc123…"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoFocus
          />
        </Field>
        <Field
          label={isUpdate ? "Client secret (leave blank to keep current)" : "Client secret"}
          required={!isUpdate}
          hint={
            isUpdate
              ? "Existing secret stays in place unless you paste a new one here."
              : "Stored encrypted (AES-GCM). Never echoed back to the UI."
          }
        >
          <Input
            type="password"
            className="mono"
            placeholder={isUpdate ? "•••••••••••• (kept)" : "Paste from the provider console"}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        {error && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
