"use client";

/**
 * GCP VPC creation wizard, embedded in chat via the ```gcp-vpc-create``` fence.
 * Same paged-wizard UX as the AWS/Azure equivalents — network + regional
 * subnets + firewall rules + optional Cloud NAT.
 */
import { useEffect, useMemo, useState } from "react";
import { Block, Btn, Field, Input, Select, type SelectOption } from "@/components/ui";
import { ApprovalCard } from "@/components/domain/ApprovalCard";
import { useProjectEnvs } from "@/hooks/queries/project";
import { useSubmitGcpVpc } from "@/hooks/queries/network";
import { GCP_REGIONS } from "@/lib/gcp-regions";

type Answers = {
  name: string;
  region: string;
  envKey: string;
  vpcCidr: string;
  subnetCount: 1 | 2 | 3;
  privateGoogleAccess: boolean;
  enableCloudNat: boolean;
  allowIapSsh: boolean;
};

const PAGE_TITLES = ["Name & basics", "Subnets & NAT", "Review"];
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

const SUBNET_COUNT_OPTIONS: SelectOption[] = [
  { value: "1", label: "1 subnet (dev/test)" },
  { value: "2", label: "2 subnets (recommended)" },
  { value: "3", label: "3 subnets (production)" },
];

export function GcpVpcCreateBox({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const submit = useSubmitGcpVpc(slug);

  const [answers, setAnswers] = useState<Answers>({
    name: "main-vpc",
    region: "us-central1",
    envKey: "",
    vpcCidr: "10.20.0.0/16",
    subnetCount: 2,
    privateGoogleAccess: true,
    enableCloudNat: true,
    allowIapSsh: true,
  });
  const [pageIdx, setPageIdx] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<{ approvalId: string; repoPath: string; repoFullName: string } | null>(null);

  useEffect(() => {
    if (answers.envKey || !envs?.length) return;
    setAnswers((a) => ({ ...a, envKey: envs[0]!.key }));
  }, [envs, answers.envKey]);

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({ value: e.key, label: e.name || e.key }));
  const regionOptions: SelectOption[] = useMemo(() => GCP_REGIONS.map((r) => ({ value: r, label: r })), []);

  const errors: Partial<Record<keyof Answers, string>> = {};
  if (pageIdx === 0) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(answers.name.trim())) errors.name = "Lowercase, dashes, 2-41 chars.";
    if (!answers.region) errors.region = "Pick a region.";
    if (!answers.envKey) errors.envKey = "Pick an env.";
    if (!CIDR_RE.test(answers.vpcCidr.trim())) errors.vpcCidr = "Not a valid IPv4 CIDR.";
  }
  const pageHasError = Object.keys(errors).length > 0;
  const onReview = pageIdx === PAGE_TITLES.length - 1;

  async function handleCreate() {
    setServerError(null);
    try {
      const res = await submit.mutateAsync({
        name: answers.name.trim(),
        envKey: answers.envKey,
        region: answers.region,
        vpcCidr: answers.vpcCidr.trim(),
        subnetCount: answers.subnetCount,
        privateGoogleAccess: answers.privateGoogleAccess,
        enableCloudNat: answers.enableCloudNat,
        allowIapSsh: answers.allowIapSsh,
      });
      if (res.approvalId) {
        setResult({ approvalId: res.approvalId, repoPath: res.repoPath ?? "", repoFullName: res.repoFullName ?? "" });
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "GCP VPC submit failed.");
    }
  }

  if (result) {
    return (
      <Block>
        <Block.Header>
          <Block.Title sub={`Files committed to ${result.repoFullName}/${result.repoPath}. Approve to run terraform apply.`}>
            GCP VPC submitted — pending approval
          </Block.Title>
        </Block.Header>
        <Block.Body>
          <ApprovalCard slug={slug} approvalId={result.approvalId} />
        </Block.Body>
      </Block>
    );
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Console-style GCP VPC creation. Network + regional subnets + firewall rules + optional Cloud NAT.">
          Create GCP VPC
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-4" style={{ maxWidth: 640 }}>
          <div className="row gap-2" style={{ alignItems: "center" }}>
            {PAGE_TITLES.map((_, i) => (
              <span key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= pageIdx ? "var(--accent, #5b8cff)" : "var(--surface-3, #00000018)" }} />
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
            Step {pageIdx + 1} of {PAGE_TITLES.length} · {PAGE_TITLES[pageIdx]}
          </span>

          {pageIdx === 0 && (
            <div className="col gap-3">
              <Field label="Name" required hint="Lowercase, dashes." error={errors.name}>
                <Input value={answers.name} onChange={(e) => setAnswers((a) => ({ ...a, name: e.target.value }))} className="mono" />
              </Field>
              <Field label="Region" required error={errors.region}>
                <Select options={regionOptions} value={answers.region} onValueChange={(v) => setAnswers((a) => ({ ...a, region: v }))} ariaLabel="Region" />
              </Field>
              <Field label="Environment" required error={errors.envKey}>
                <Select options={envOptions} value={answers.envKey} onValueChange={(v) => setAnswers((a) => ({ ...a, envKey: v }))} ariaLabel="Env" placeholder="Pick an env…" />
              </Field>
              <Field label="VPC CIDR" required hint="Any RFC1918 range. Subnet CIDRs are auto-carved from this /16." error={errors.vpcCidr}>
                <Input value={answers.vpcCidr} onChange={(e) => setAnswers((a) => ({ ...a, vpcCidr: e.target.value }))} className="mono" />
              </Field>
            </div>
          )}

          {pageIdx === 1 && (
            <div className="col gap-3">
              <Field label="Subnets" hint="GCP subnets are regional (not zonal like AWS). All picked subnets live in the region you chose.">
                <Select options={SUBNET_COUNT_OPTIONS} value={String(answers.subnetCount)} onValueChange={(v) => setAnswers((a) => ({ ...a, subnetCount: Number(v) as 1 | 2 | 3 }))} ariaLabel="Subnet count" />
              </Field>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={answers.privateGoogleAccess} onChange={(e) => setAnswers((a) => ({ ...a, privateGoogleAccess: e.target.checked }))} />
                <span>Private Google Access (VMs without a public IP can still reach googleapis.com — strongly recommended)</span>
              </label>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={answers.enableCloudNat} onChange={(e) => setAnswers((a) => ({ ...a, enableCloudNat: e.target.checked }))} />
                <span>Cloud NAT (outbound internet for private VMs — flat $0.045/hr, no per-GB fee)</span>
              </label>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={answers.allowIapSsh} onChange={(e) => setAnswers((a) => ({ ...a, allowIapSsh: e.target.checked }))} />
                <span>Allow SSH via IAP (safer than opening TCP/22 to 0.0.0.0/0)</span>
              </label>
            </div>
          )}

          {onReview && (
            <div className="col gap-3">
              <div className="col gap-1" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
                <ReviewRow label="Name" value={answers.name} />
                <ReviewRow label="Region" value={answers.region} />
                <ReviewRow label="Environment" value={envs?.find((e) => e.key === answers.envKey)?.name ?? answers.envKey} />
                <ReviewRow label="VPC CIDR" value={answers.vpcCidr} />
                <ReviewRow label="Subnets" value={String(answers.subnetCount)} />
                <ReviewRow label="Private Google Access" value={answers.privateGoogleAccess ? "yes" : "no"} />
                <ReviewRow label="Cloud NAT" value={answers.enableCloudNat ? "yes" : "no"} />
                <ReviewRow label="IAP SSH" value={answers.allowIapSsh ? "yes" : "no"} />
              </div>
              {serverError && <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">{serverError}</p>}
            </div>
          )}

          <div className="row gap-2" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <Btn variant="ghost" onClick={() => setPageIdx((i) => Math.max(0, i - 1))} disabled={pageIdx === 0 || submit.isPending}>Back</Btn>
            {onReview ? (
              <Btn variant="primary" icon="plus" loading={submit.isPending} onClick={handleCreate}>Create VPC</Btn>
            ) : (
              <Btn variant="primary" onClick={() => !pageHasError && setPageIdx((i) => Math.min(PAGE_TITLES.length - 1, i + 1))} disabled={pageHasError}>Next</Btn>
            )}
          </div>
        </div>
      </Block.Body>
    </Block>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between" style={{ gap: 12, fontSize: 13 }}>
      <span className="muted">{label}</span>
      <span style={{ fontWeight: 600, textAlign: "right", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}
