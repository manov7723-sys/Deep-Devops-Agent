"use client";

/**
 * Submit an infra change to the approval GATE — the manual (no-AI) way to test
 * the Plan → Policy → Approval → Apply pipeline. Runs the same policy + cost
 * checks the agent's request_infra_approval tool does; a pass creates a pending
 * approval in the list below, a fail is blocked with the reasons.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, Select, Toggle } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type EnvOpt = { key: string; name: string; cloud: string | null };
type Meta = { ok: true; envs: EnvOpt[] };
type Violation = { rule: string; message: string; severity: string };
type SubmitResp =
  | { ok: true; status: "pending_approval"; approvalId: string; risk: string; costMonthly: number }
  | { ok: true; status: "blocked"; violations: Violation[]; costMonthly: number };

const CLOUD_LABEL: Record<string, string> = { aws: "AWS", azure: "Azure", gcp: "GCP" };

const SAMPLE_PUBLIC_S3 = `resource "aws_s3_bucket" "assets" {
  bucket = "my-public-assets"
}
resource "aws_s3_bucket_acl" "assets" {
  bucket = aws_s3_bucket.assets.id
  acl    = "public-read"
}`;

export function InfraGateSubmitPanel({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const meta = useQuery<Meta>({
    queryKey: ["p", slug, "infra-gate-meta"],
    queryFn: () => api.get<Meta>(`/projects/${slug}/approvals/infra`),
    enabled: open,
  });
  const envs = meta.data?.envs ?? [];

  const [envKey, setEnvKey] = useState("");
  const [title, setTitle] = useState("Create S3 bucket");
  const [region, setRegion] = useState("");
  const [instanceType, setInstanceType] = useState("");
  const [nodeCount, setNodeCount] = useState("0");
  const [managedK8s, setManagedK8s] = useState(false);
  const [storageGb, setStorageGb] = useState("0");
  const [publicBucket, setPublicBucket] = useState(false);
  const [hcl, setHcl] = useState("");

  const activeEnv = envKey || envs[0]?.key || "";
  const envOptions = useMemo(
    () =>
      envs.map((e) => ({
        value: e.key,
        label: `${e.name || e.key}${e.cloud ? ` · ${e.cloud.toUpperCase()}` : ""}`,
      })),
    [envs],
  );
  // The cloud is a property of the chosen ENVIRONMENT — i.e. THIS project's
  // connected cloud. There is no free cloud picker: infra is always scoped to the
  // env's cloud (aws | azure | gcp). null means that env has no cloud connected.
  const selectedEnv = envs.find((e) => e.key === activeEnv);
  const activeCloud: "aws" | "azure" | "gcp" | null =
    selectedEnv?.cloud === "aws" || selectedEnv?.cloud === "azure" || selectedEnv?.cloud === "gcp"
      ? selectedEnv.cloud
      : null;
  const regionPh =
    activeCloud === "azure" ? "eastus" : activeCloud === "gcp" ? "us-central1" : "us-east-1";

  const submit = useMutation({
    mutationFn: () =>
      api.post<SubmitResp>(`/projects/${slug}/approvals/infra`, {
        envKey: activeEnv,
        cloud: activeCloud,
        title: title.trim(),
        region: region.trim() || undefined,
        instanceType: instanceType.trim() || undefined,
        nodeCount: Number(nodeCount) || 0,
        managedK8s,
        storageGb: Number(storageGb) || 0,
        publicBucket,
        hcl: hcl.trim() || undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }),
  });
  const r = submit.data;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Manually push an infra change through the policy gate — for testing/demo without the AI. A pass appears in the queue below; a fail is blocked with reasons.">
          Submit a change to the gate
        </Block.Title>
        <Block.Actions>
          <Btn
            variant={open ? "outline" : "primary"}
            icon={open ? undefined : "plus"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Close" : "New change"}
          </Btn>
        </Block.Actions>
      </Block.Header>
      {open && (
        <Block.Body>
          {envs.length === 0 ? (
            <span className="muted" style={{ fontSize: 13 }}>
              {meta.isLoading ? "Loading…" : "No environments found — create one first."}
            </span>
          ) : (
            <div className="col gap-3">
              <div className="row gap-3 wrap" style={{ alignItems: "flex-end" }}>
                <div style={{ minWidth: 180 }}>
                  <Field label="Environment">
                    <Select
                      value={activeEnv}
                      onValueChange={setEnvKey}
                      ariaLabel="Env"
                      options={envOptions}
                    />
                  </Field>
                </div>
                <div style={{ minWidth: 90 }}>
                  <Field label="Cloud">
                    <div style={{ paddingTop: 6 }}>
                      {activeCloud ? (
                        <Badge tone="info" icon="cloud">
                          {CLOUD_LABEL[activeCloud]}
                        </Badge>
                      ) : (
                        <Badge tone="warn">no cloud on this env</Badge>
                      )}
                    </div>
                  </Field>
                </div>
                <div style={{ minWidth: 220, flex: 1 }}>
                  <Field label="Title">
                    <Input value={title} onChange={(e) => setTitle(e.target.value)} />
                  </Field>
                </div>
              </div>
              <div className="row gap-3 wrap" style={{ alignItems: "flex-end" }}>
                <div style={{ minWidth: 140 }}>
                  <Field label="Region">
                    <Input
                      value={region}
                      placeholder={regionPh}
                      onChange={(e) => setRegion(e.target.value)}
                    />
                  </Field>
                </div>
                <div style={{ minWidth: 140 }}>
                  <Field label="Instance type">
                    <Input
                      value={instanceType}
                      placeholder="(optional)"
                      onChange={(e) => setInstanceType(e.target.value)}
                    />
                  </Field>
                </div>
                <div style={{ minWidth: 80 }}>
                  <Field label="Nodes">
                    <Input
                      type="number"
                      value={nodeCount}
                      onChange={(e) => setNodeCount(e.target.value)}
                    />
                  </Field>
                </div>
                <div style={{ minWidth: 100 }}>
                  <Field label="Storage GB">
                    <Input
                      type="number"
                      value={storageGb}
                      onChange={(e) => setStorageGb(e.target.value)}
                    />
                  </Field>
                </div>
                <div className="row gap-2" style={{ alignItems: "center", paddingBottom: 8 }}>
                  <Toggle
                    checked={managedK8s}
                    onCheckedChange={setManagedK8s}
                    ariaLabel="Managed K8s"
                  />
                  <span style={{ fontSize: 13 }}>Managed K8s</span>
                </div>
                <div className="row gap-2" style={{ alignItems: "center", paddingBottom: 8 }}>
                  <Toggle
                    checked={publicBucket}
                    onCheckedChange={setPublicBucket}
                    ariaLabel="Public bucket"
                  />
                  <span style={{ fontSize: 13 }}>Public bucket</span>
                </div>
              </div>
              <Field label="Terraform (optional — scanned by policy)">
                <textarea
                  value={hcl}
                  onChange={(e) => setHcl(e.target.value)}
                  rows={5}
                  placeholder="resource ... { }"
                  style={{
                    width: "100%",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: 12,
                    padding: 8,
                    borderRadius: 6,
                    border: "1px solid var(--border-soft)",
                    background: "var(--surface-2)",
                  }}
                />
              </Field>
              <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
                <Btn
                  variant="primary"
                  icon="shield"
                  loading={submit.isPending}
                  disabled={!activeEnv || !activeCloud || !title.trim() || submit.isPending}
                  onClick={() => submit.mutate()}
                >
                  Submit to gate
                </Btn>
                <Btn
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setTitle("Public S3 bucket (should be blocked)");
                    setPublicBucket(true);
                    setHcl(SAMPLE_PUBLIC_S3);
                  }}
                >
                  Load a policy-violating sample
                </Btn>
              </div>

              {submit.isError && (
                <Badge tone="danger" icon="alert">
                  {apiErrorMessage(submit.error)}
                </Badge>
              )}
              {r?.status === "pending_approval" && (
                <Badge tone="ok" icon="check">
                  Submitted — pending approval (~${r.costMonthly}/mo, risk {r.risk}). See the queue
                  below and approve it.
                </Badge>
              )}
              {r?.status === "blocked" && (
                <div className="col gap-1">
                  <Badge tone="danger" icon="shield">
                    Blocked by policy — nothing was created.
                  </Badge>
                  <ul
                    className="faint"
                    style={{ fontSize: 12, margin: "2px 0 0", paddingLeft: 16 }}
                  >
                    {r.violations.map((v, i) => (
                      <li key={i}>
                        <b>{v.rule}</b>: {v.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Block.Body>
      )}
    </Block>
  );
}
