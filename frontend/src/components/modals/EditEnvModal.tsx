"use client";

import { useEffect, useState } from "react";
import { Btn, Field, Input, Modal, StatusDot, Textarea, Toggle } from "@/components/ui";
import {
  useDeleteEnv,
  useUpdateEnv,
  useVerifyCluster,
  type ProjectEnv,
  type UpdateEnvPatch,
  type VerifyClusterResult,
} from "@/hooks/queries/project";

export interface EditEnvModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
  /**
   * Use the live env row from `useProjectEnvs()` so deletes/renames take effect
   * after server invalidation.
   */
  env: ProjectEnv;
}

/** Edit core env fields (name, region, terraformWorkspace, url, toggles) via PATCH. */
export function EditEnvModal({ open, onOpenChange, projectSlug, env }: EditEnvModalProps) {
  const update = useUpdateEnv(projectSlug);
  const remove = useDeleteEnv(projectSlug);
  const verify = useVerifyCluster(projectSlug);

  const [name, setName] = useState(env.name);
  const [url, setUrl] = useState(env.url ?? "");
  const [region, setRegion] = useState(env.region ?? "");
  const [terraformWorkspace, setTerraformWorkspace] = useState(env.terraformWorkspace ?? "");
  const [isProduction, setIsProduction] = useState(env.isProduction);
  const [autoDeploy, setAutoDeploy] = useState(env.autoDeploy);
  // Phase 1: kubeconfig + namespace for cluster wiring.
  const [kubeconfig, setKubeconfig] = useState("");
  const [namespace, setNamespace] = useState(env.namespace ?? "default");
  const [verifyResult, setVerifyResult] = useState<VerifyClusterResult | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(env.name);
    setUrl(env.url ?? "");
    setRegion(env.region ?? "");
    setTerraformWorkspace(env.terraformWorkspace ?? "");
    setIsProduction(env.isProduction);
    setAutoDeploy(env.autoDeploy);
    setKubeconfig("");
    setNamespace(env.namespace ?? "default");
    setVerifyResult(null);
    setServerError(null);
    setConfirmDelete(false);
  }, [open, env]);

  const fallbackWorkspace = `${projectSlug}-${env.key}`;

  async function submit() {
    setServerError(null);
    const patch: UpdateEnvPatch = {};
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== env.name) patch.name = trimmedName;
    if (isProduction !== env.isProduction) patch.isProduction = isProduction;
    if (autoDeploy !== env.autoDeploy) patch.autoDeploy = autoDeploy;
    const trimmedRegion = region.trim();
    if (trimmedRegion !== (env.region ?? "")) patch.region = trimmedRegion;
    const trimmedWs = terraformWorkspace.trim();
    if (trimmedWs !== (env.terraformWorkspace ?? "")) patch.terraformWorkspace = trimmedWs;
    const trimmedUrl = url.trim();
    const currentUrl = env.url ?? "";
    if (trimmedUrl !== currentUrl) patch.url = trimmedUrl ? trimmedUrl : null;
    const trimmedNs = namespace.trim();
    if (trimmedNs && trimmedNs !== env.namespace) patch.namespace = trimmedNs;
    // Only send kubeconfig if the user typed/pasted something — empty
    // textarea keeps the existing one. Pasting whitespace doesn't count.
    if (kubeconfig.trim().length > 0) patch.kubeconfig = kubeconfig;

    if (Object.keys(patch).length === 0) {
      onOpenChange(false);
      return;
    }
    try {
      await update.mutateAsync({ key: env.key, patch });
      onOpenChange(false);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Could not save.");
    }
  }

  async function doDelete() {
    setServerError(null);
    try {
      await remove.mutateAsync(env.key);
      onOpenChange(false);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Could not delete.");
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${env.name}`}
      description={`Key: ${env.key} · Settings here apply to all deployments to this env.`}
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
              onClick={doDelete}
              style={{ background: "var(--danger)", borderColor: "var(--danger)" }}
            >
              Yes, delete environment
            </Btn>
          </>
        ) : (
          <>
            <Btn variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Btn>
            <Btn variant="primary" icon="check" loading={update.isPending} onClick={submit}>
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

        <Field label="Public URL" hint="Leave blank to clear.">
          <Input
            type="url"
            placeholder="https://app.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>

        <div className="row gap-3">
          <Field label="Region" hint="Cloud region used as default for this env.">
            <Input
              className="mono"
              placeholder="us-east-1"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            />
          </Field>
          <Field label="Terraform workspace" hint={`Defaults to ${fallbackWorkspace} when blank.`}>
            <Input
              className="mono"
              placeholder={fallbackWorkspace}
              value={terraformWorkspace}
              onChange={(e) => setTerraformWorkspace(e.target.value)}
            />
          </Field>
        </div>

        <div className="row between">
          <span>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Production</span>
            <br />
            <span className="faint" style={{ fontSize: 11.5 }}>
              Triggers approval gates on every deploy.
            </span>
          </span>
          <Toggle checked={isProduction} onCheckedChange={setIsProduction} ariaLabel="Production" />
        </div>
        <div className="row between">
          <span>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Auto-deploy</span>
            <br />
            <span className="faint" style={{ fontSize: 11.5 }}>
              Push to a wired branch → automatic pipeline.
            </span>
          </span>
          <Toggle checked={autoDeploy} onCheckedChange={setAutoDeploy} ariaLabel="Auto-deploy" />
        </div>

        {/* ─── Cluster wiring (Phase 1) ─────────────────────────────── */}
        <div
          className="col gap-3"
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 14,
            background: "var(--surface-2)",
          }}
        >
          <div className="row between" style={{ alignItems: "center" }}>
            <span
              className="row gap-2"
              style={{ alignItems: "center", fontWeight: 600, fontSize: 13 }}
            >
              Kubernetes cluster
              {env.hasKubeconfig ? (
                <StatusDot tone="ok" label="wired" />
              ) : (
                <StatusDot tone="warn" label="not wired" />
              )}
            </span>
            <Btn
              size="sm"
              variant="outline"
              icon="check"
              loading={verify.isPending}
              disabled={!env.hasKubeconfig && kubeconfig.trim().length === 0}
              onClick={async () => {
                setVerifyResult(null);
                try {
                  // If they pasted a new kubeconfig but didn't save yet,
                  // save first so verify uses the new one.
                  if (kubeconfig.trim().length > 0) {
                    await update.mutateAsync({
                      key: env.key,
                      patch: { kubeconfig, namespace: namespace.trim() || "default" },
                    });
                    setKubeconfig("");
                  }
                  const r = await verify.mutateAsync(env.key);
                  setVerifyResult(r);
                } catch (e) {
                  setVerifyResult({
                    ok: false,
                    code: "client_error",
                    message: e instanceof Error ? e.message : "Verify failed.",
                  });
                }
              }}
            >
              Verify cluster
            </Btn>
          </div>
          <Field label="Namespace" hint="Namespace where deployments land. Created if missing.">
            <Input
              className="mono"
              placeholder="default"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
            />
          </Field>
          <Field
            label={env.hasKubeconfig ? "Replace kubeconfig (optional)" : "Kubeconfig YAML"}
            hint={
              env.hasKubeconfig
                ? "Leave blank to keep the existing one. Paste a new YAML to replace."
                : "Paste the full kubeconfig YAML — encrypted at rest with AES-GCM."
            }
          >
            <Textarea
              rows={5}
              placeholder="apiVersion: v1&#10;clusters:&#10;- cluster:&#10;    server: https://..."
              value={kubeconfig}
              onChange={(e) => setKubeconfig(e.target.value)}
              className="mono"
              style={{ fontSize: 12 }}
            />
          </Field>
          {verifyResult && (
            <div
              role={verifyResult.ok ? "status" : "alert"}
              style={{
                padding: "10px 12px",
                borderRadius: 6,
                background: verifyResult.ok ? "var(--ok-soft)" : "var(--danger-soft)",
                color: verifyResult.ok ? "var(--ok)" : "var(--danger)",
                fontSize: 12.5,
                lineHeight: 1.5,
              }}
            >
              {verifyResult.ok ? (
                <>
                  <b>
                    Connected — {verifyResult.nodes.length} node
                    {verifyResult.nodes.length === 1 ? "" : "s"} · {verifyResult.durationMs}ms
                  </b>
                  <div className="col" style={{ marginTop: 6 }}>
                    {verifyResult.nodes.slice(0, 5).map((n) => (
                      <span key={n.name} className="mono" style={{ fontSize: 11 }}>
                        {n.name} · {n.status} · {n.version}
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <b>{verifyResult.message}</b>
                  {verifyResult.stderr && (
                    <pre
                      style={{
                        marginTop: 6,
                        whiteSpace: "pre-wrap",
                        fontSize: 11,
                        maxHeight: 160,
                        overflowY: "auto",
                      }}
                    >
                      {verifyResult.stderr}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </div>

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
              Deleting <b>{env.name}</b> removes its configuration. It can&apos;t be deleted if
              there are existing deployments — promote or roll back first.
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
              Delete this environment…
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
