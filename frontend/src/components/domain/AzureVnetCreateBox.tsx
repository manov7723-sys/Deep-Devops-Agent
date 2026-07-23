"use client";

/**
 * Azure VNet creation wizard, embedded in chat via the ```azure-vnet-create```
 * fence. Same paged-wizard UX as VpcCreateBox — Azure's equivalent of the
 * AWS VPC console flow.
 */
import { useEffect, useMemo, useState } from "react";
import { Block, Btn, Field, Input, Select, type SelectOption } from "@/components/ui";
import { ApprovalCard } from "@/components/domain/ApprovalCard";
import { useProjectEnvs } from "@/hooks/queries/project";
import { useSubmitAzureVnet } from "@/hooks/queries/network";
import { AZURE_LOCATIONS } from "@/lib/azure-locations";

type NatStrategy = "none" | "single";
type Answers = {
  name: string;
  location: string;
  envKey: string;
  vnetCidr: string;
  subnetCount: 1 | 2 | 3;
  includePrivateSubnets: boolean;
  natStrategy: NatStrategy;
  createDefaultNsgs: boolean;
};

const PAGE_TITLES = ["Name & basics", "Subnets & NAT", "Review"];
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

const SUBNET_COUNT_OPTIONS: SelectOption[] = [
  { value: "1", label: "1 subnet per tier (dev/test)" },
  { value: "2", label: "2 subnets per tier (recommended)" },
  { value: "3", label: "3 subnets per tier (production)" },
];
const NAT_OPTIONS: SelectOption[] = [
  { value: "none", label: "No NAT (private subnets outbound-blocked)" },
  { value: "single", label: "Single NAT gateway (recommended — ~$32/mo)" },
];

export function AzureVnetCreateBox({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const submit = useSubmitAzureVnet(slug);

  const [answers, setAnswers] = useState<Answers>({
    name: "main-vnet",
    location: "eastus",
    envKey: "",
    vnetCidr: "10.10.0.0/16",
    subnetCount: 2,
    includePrivateSubnets: true,
    natStrategy: "single",
    createDefaultNsgs: true,
  });
  const [pageIdx, setPageIdx] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<{ approvalId: string; repoPath: string; repoFullName: string } | null>(null);

  useEffect(() => {
    if (answers.envKey || !envs?.length) return;
    setAnswers((a) => ({ ...a, envKey: envs[0]!.key }));
  }, [envs, answers.envKey]);

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({ value: e.key, label: e.name || e.key }));
  const locationOptions: SelectOption[] = useMemo(() => AZURE_LOCATIONS.map((l) => ({ value: l, label: l })), []);

  const errors: Partial<Record<keyof Answers, string>> = {};
  if (pageIdx === 0) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(answers.name.trim())) errors.name = "Lowercase, dashes, 2-41 chars.";
    if (!answers.location) errors.location = "Pick a location.";
    if (!answers.envKey) errors.envKey = "Pick an env.";
    if (!CIDR_RE.test(answers.vnetCidr.trim())) errors.vnetCidr = "Not a valid IPv4 CIDR.";
  }
  const pageHasError = Object.keys(errors).length > 0;
  const onReview = pageIdx === PAGE_TITLES.length - 1;

  const previewSubnetCount = answers.subnetCount * (answers.includePrivateSubnets ? 2 : 1);

  async function handleCreate() {
    setServerError(null);
    try {
      const res = await submit.mutateAsync({
        name: answers.name.trim(),
        envKey: answers.envKey,
        location: answers.location,
        vnetCidr: answers.vnetCidr.trim(),
        subnetCount: answers.subnetCount,
        includePrivateSubnets: answers.includePrivateSubnets,
        natStrategy: answers.includePrivateSubnets ? answers.natStrategy : "none",
        createDefaultNsgs: answers.createDefaultNsgs,
      });
      if (res.approvalId) {
        setResult({
          approvalId: res.approvalId,
          repoPath: res.repoPath ?? "",
          repoFullName: res.repoFullName ?? "",
        });
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Azure VNet submit failed.");
    }
  }

  if (result) {
    return (
      <Block>
        <Block.Header>
          <Block.Title sub={`Files committed to ${result.repoFullName}/${result.repoPath}. Approve to run terraform apply.`}>
            Azure VNet submitted — pending approval
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
        <Block.Title sub="Console-style Azure VNet creation. Resource group + VNet + subnets + optional NAT gateway.">
          Create Azure VNet
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-4" style={{ maxWidth: 640 }}>
          <div className="row gap-2" style={{ alignItems: "center" }}>
            {PAGE_TITLES.map((_, i) => (
              <span key={i} style={{
                flex: 1, height: 4, borderRadius: 2,
                background: i <= pageIdx ? "var(--accent, #5b8cff)" : "var(--surface-3, #00000018)",
              }} />
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
            Step {pageIdx + 1} of {PAGE_TITLES.length} · {PAGE_TITLES[pageIdx]}
          </span>

          {pageIdx === 0 && (
            <div className="col gap-3">
              <Field label="Name prefix" required hint="Lowercase, dashes. Also used as the resource group name (${name}-rg)." error={errors.name}>
                <Input value={answers.name} onChange={(e) => setAnswers((a) => ({ ...a, name: e.target.value }))} className="mono" />
              </Field>
              <Field label="Location" required error={errors.location}>
                <Select options={locationOptions} value={answers.location} onValueChange={(v) => setAnswers((a) => ({ ...a, location: v }))} ariaLabel="Location" />
              </Field>
              <Field label="Environment" required error={errors.envKey}>
                <Select options={envOptions} value={answers.envKey} onValueChange={(v) => setAnswers((a) => ({ ...a, envKey: v }))} ariaLabel="Environment" placeholder="Pick an env…" />
              </Field>
              <Field label="VNet CIDR" required hint="Use DISTINCT CIDRs if you plan to peer VNets later. Subnet CIDRs are auto-carved from this /16." error={errors.vnetCidr}>
                <Input value={answers.vnetCidr} onChange={(e) => setAnswers((a) => ({ ...a, vnetCidr: e.target.value }))} className="mono" />
              </Field>
            </div>
          )}

          {pageIdx === 1 && (
            <div className="col gap-3">
              <Field label="Subnets per tier" hint="Each tier (public/private) gets this many subnets.">
                <Select options={SUBNET_COUNT_OPTIONS} value={String(answers.subnetCount)} onValueChange={(v) => setAnswers((a) => ({ ...a, subnetCount: Number(v) as 1 | 2 | 3 }))} ariaLabel="Subnet count" />
              </Field>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={answers.includePrivateSubnets} onChange={(e) => setAnswers((a) => ({ ...a, includePrivateSubnets: e.target.checked }))} />
                <span>Also create a private subnet tier (recommended)</span>
              </label>
              {answers.includePrivateSubnets && (
                <Field label="NAT for private subnets" hint="NAT gives private subnets stable outbound internet. Azure denies inbound by default anyway, so private without NAT = fully isolated.">
                  <Select options={NAT_OPTIONS} value={answers.natStrategy} onValueChange={(v) => setAnswers((a) => ({ ...a, natStrategy: v as NatStrategy }))} ariaLabel="NAT strategy" />
                </Field>
              )}
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={answers.createDefaultNsgs} onChange={(e) => setAnswers((a) => ({ ...a, createDefaultNsgs: e.target.checked }))} />
                <span>Attach a Network Security Group to each subnet (recommended)</span>
              </label>
              <div className="muted" style={{ fontSize: 12, padding: 10, background: "var(--surface-2)", borderRadius: 8 }}>
                Preview: {answers.subnetCount} subnet{answers.subnetCount === 1 ? "" : "s"}/tier ·{" "}
                {previewSubnetCount} total subnet{previewSubnetCount === 1 ? "" : "s"}
                {answers.includePrivateSubnets && answers.natStrategy === "single" ? " · 1 NAT gateway" : ""}.
                Auto-carved from {answers.vnetCidr}.
              </div>
            </div>
          )}

          {onReview && (
            <div className="col gap-3">
              <div className="col gap-1" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
                <ReviewRow label="Name" value={answers.name} />
                <ReviewRow label="Location" value={answers.location} />
                <ReviewRow label="Environment" value={envs?.find((e) => e.key === answers.envKey)?.name ?? answers.envKey} />
                <ReviewRow label="VNet CIDR" value={answers.vnetCidr} />
                <ReviewRow label="Subnets" value={`${answers.subnetCount} public${answers.includePrivateSubnets ? ` + ${answers.subnetCount} private` : ""}`} />
                {answers.includePrivateSubnets && <ReviewRow label="NAT" value={answers.natStrategy === "single" ? "Single NAT gateway" : "None (isolated)"} />}
                <ReviewRow label="NSGs" value={answers.createDefaultNsgs ? "one per tier" : "none"} />
              </div>
              {serverError && <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">{serverError}</p>}
            </div>
          )}

          <div className="row gap-2" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <Btn variant="ghost" onClick={() => setPageIdx((i) => Math.max(0, i - 1))} disabled={pageIdx === 0 || submit.isPending}>Back</Btn>
            {onReview ? (
              <Btn variant="primary" icon="plus" loading={submit.isPending} onClick={handleCreate}>Create VNet</Btn>
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
