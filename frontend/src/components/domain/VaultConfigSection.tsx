"use client";

import { useEffect, useState } from "react";
import { Badge, Block, Btn, Field, Input } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import { CloudCredentialsModal } from "@/components/modals/CloudCredentialsModal";
import {
  useVaultConfig,
  useVaultStatus,
  useSaveVaultConfig,
  useDeleteVaultConfig,
} from "@/hooks/queries/connectivity";

export type VaultAwsProvider = {
  providerId: string;
  name: string;
  region: string;
  hasVaultCreds: boolean;
};

/**
 * Vault configuration section for the Cloud providers page — port of the
 * original backend/frontend "Vault config" panel, in two ordered steps:
 *
 *   Step 1 — Vault connection: the user enters their Vault URL + token (hvs.…).
 *            It's tested against Vault and saved (token encrypted at rest).
 *   Step 2 — AWS keys: store an access key + secret per AWS account INTO Vault.
 *            Enabled only once the connection is live.
 *
 * The agent reads the keys back from Vault at runtime (resolveAwsExecEnv →
 * getAwsKeys), so they're used automatically whenever a tool needs AWS access.
 */
export function VaultConfigSection({
  slug,
  awsProviders,
}: {
  slug: string;
  awsProviders: VaultAwsProvider[];
}) {
  const config = useVaultConfig(slug);
  const status = useVaultStatus(slug);
  const save = useSaveVaultConfig(slug);
  const disconnect = useDeleteVaultConfig(slug);

  const [addr, setAddr] = useState("");
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [credFor, setCredFor] = useState<{ id: string; name: string } | null>(null);

  const configured = !!config.data?.configured;
  const reachable = !!status.data?.reachable;
  const fromEnv = config.data?.source === "env";

  // Prefill the URL when editing an existing DB connection.
  useEffect(() => {
    if (editing && config.data?.addr) setAddr(config.data.addr);
  }, [editing, config.data?.addr]);

  async function submit() {
    setFormError(null);
    try {
      await save.mutateAsync({ addr: addr.trim(), token: token.trim() });
      setToken("");
      setEditing(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Could not save Vault connection.");
    }
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Step 1: connect Vault. Step 2: store AWS keys in it. Keys never touch the database — the agent reads them from Vault at runtime.">
          <span className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="lock" size={16} /> Vault configuration
          </span>
        </Block.Title>
      </Block.Header>

      <div className="col gap-4">
        {/* ── Connection status ───────────────────────────────────────── */}
        <div className="row gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <span className="text-sm muted">Connection</span>
          {config.isLoading || status.isLoading ? (
            <Badge tone="default">checking…</Badge>
          ) : !configured ? (
            <Badge tone="warn" withDot>
              not connected
            </Badge>
          ) : reachable ? (
            <>
              <Badge tone="ok" withDot>
                connected
              </Badge>
              {config.data?.addr && (
                <span className="faint mono" style={{ fontSize: 12 }}>
                  {config.data.addr}
                </span>
              )}
              {fromEnv && (
                <span className="faint" style={{ fontSize: 11 }}>
                  (from server env)
                </span>
              )}
            </>
          ) : (
            <>
              <Badge tone="danger" withDot>
                unreachable
              </Badge>
              <span className="faint" style={{ fontSize: 12 }}>
                {status.data?.error ?? "Check URL / token."}
              </span>
            </>
          )}
        </div>

        {/* ── Step 1: Vault connection form ───────────────────────────── */}
        {!configured || editing ? (
          <div className="col gap-3" style={{ maxWidth: 520 }}>
            <Field
              label="Vault URL"
              required
              hint="Your Vault address, e.g. https://vault.example.com:8200"
            >
              <Input
                className="mono"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder="https://127.0.0.1:8200"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field
              label="Vault token"
              required
              hint="A token with read/write on the KV mount (hvs.…). Stored encrypted; never shown again."
            >
              <Input
                type="password"
                className="mono"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="hvs.••••••••••••••••••••••••"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <div className="row gap-2" style={{ alignItems: "center" }}>
              <Btn
                variant="primary"
                icon="link"
                loading={save.isPending}
                disabled={!addr.trim() || !token.trim() || save.isPending}
                onClick={submit}
              >
                {save.isPending ? "Testing…" : "Save & test connection"}
              </Btn>
              {editing && (
                <Btn
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setToken("");
                    setFormError(null);
                  }}
                >
                  Cancel
                </Btn>
              )}
            </div>
            {formError && (
              <span style={{ fontSize: 12.5, color: "var(--danger)" }}>{formError}</span>
            )}
          </div>
        ) : (
          <div className="row gap-2">
            {!fromEnv && (
              <Btn variant="outline" size="sm" icon="refresh" onClick={() => setEditing(true)}>
                Edit connection
              </Btn>
            )}
            {!fromEnv && (
              <Btn
                variant="danger"
                size="sm"
                loading={disconnect.isPending}
                onClick={() => disconnect.mutate()}
              >
                Disconnect
              </Btn>
            )}
            {fromEnv && (
              <span className="faint" style={{ fontSize: 12 }}>
                Connection comes from the server&apos;s VAULT_ADDR / VAULT_TOKEN env vars.
              </span>
            )}
          </div>
        )}

        {/* ── Step 2: AWS keys per account ────────────────────────────── */}
        <div className="col gap-2" style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
          <span className="text-sm" style={{ fontWeight: 600 }}>
            AWS access keys
          </span>
          {!configured ? (
            <span className="muted" style={{ fontSize: 13 }}>
              Connect Vault above first, then store your AWS keys here.
            </span>
          ) : awsProviders.length === 0 ? (
            <span className="muted" style={{ fontSize: 13 }}>
              Connect an AWS account above — then store its access key + secret here.
            </span>
          ) : (
            awsProviders.map((p) => (
              <div
                key={p.providerId}
                className="row gap-3"
                style={{ alignItems: "center", justifyContent: "space-between" }}
              >
                <div className="row gap-2" style={{ alignItems: "center" }}>
                  <span style={{ fontWeight: 600 }}>{p.name}</span>
                  <span className="text-sm muted">{p.region}</span>
                  {p.hasVaultCreds ? (
                    <Badge tone="ok" withDot>
                      keys in Vault
                    </Badge>
                  ) : (
                    <Badge tone="warn" withDot>
                      no keys
                    </Badge>
                  )}
                </div>
                <Btn
                  variant="outline"
                  size="sm"
                  icon="lock"
                  disabled={!reachable}
                  title={reachable ? "" : "Vault must be connected to store keys."}
                  onClick={() => setCredFor({ id: p.providerId, name: p.name })}
                >
                  {p.hasVaultCreds ? "Update keys" : "Add keys"}
                </Btn>
              </div>
            ))
          )}
        </div>
      </div>

      <CloudCredentialsModal
        open={!!credFor}
        onOpenChange={(o) => !o && setCredFor(null)}
        providerId={credFor?.id ?? null}
        providerName={credFor?.name ?? ""}
        slug={slug}
      />
    </Block>
  );
}
