"use client";

/**
 * VPC creation wizard, embedded in chat via the ```vpc-create``` fence.
 * Console-style flow that matches AWS's "VPC and more" launch wizard —
 * multi-AZ, optional private subnets, optional NAT gateway(s) (single or
 * per-AZ), DNS toggles. Subnet CIDRs are auto-carved from the VPC /16 by
 * the generator, so the user doesn't hand-write them.
 *
 * Same paged-wizard UX as Ec2CreateBox / EksChatBox — no LLM once the fence
 * is emitted; this component owns the whole flow through the approval-card.
 */
import { useEffect, useMemo, useState } from "react";
import { Block, Btn, Field, Input, Select, type SelectOption } from "@/components/ui";
import { ApprovalCard } from "@/components/domain/ApprovalCard";
import { useProjectEnvs } from "@/hooks/queries/project";
import { useSubmitVpc } from "@/hooks/queries/network";

// Shared across every AWS picker in the app — see lib/aws-regions.ts.
import { AWS_REGIONS } from "@/lib/aws-regions";

type NatStrategy = "none" | "single" | "per_az";

type Answers = {
  name: string;
  region: string;
  envKey: string;
  vpcCidr: string;
  azCount: 1 | 2 | 3;
  includePrivateSubnets: boolean;
  natStrategy: NatStrategy;
  dnsHostnames: boolean;
  dnsSupport: boolean;
};

const PAGE_TITLES = ["Name & basics", "Availability & DNS", "Subnets & NAT", "Review"];

// Reused CIDR regex — server does the strict validation.
const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

const AZ_OPTIONS: SelectOption[] = [
  { value: "1", label: "1 AZ (dev/test — no HA)" },
  { value: "2", label: "2 AZs (recommended — HA baseline)" },
  { value: "3", label: "3 AZs (production — full HA)" },
];

const NAT_OPTIONS: SelectOption[] = [
  { value: "none", label: "No NAT (private subnets isolated — no outbound internet)" },
  { value: "single", label: "Single NAT gateway (shared, cheapest — ~$33/mo)" },
  { value: "per_az", label: "One NAT per AZ (highly available — cost scales with AZ count)" },
];

export function VpcCreateBox({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const submit = useSubmitVpc(slug);

  const [answers, setAnswers] = useState<Answers>({
    name: "main-vpc",
    region: "us-east-1",
    envKey: "",
    vpcCidr: "10.0.0.0/16",
    azCount: 2,
    includePrivateSubnets: true,
    natStrategy: "single",
    dnsHostnames: true,
    dnsSupport: true,
  });
  const [pageIdx, setPageIdx] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    approvalId: string;
    repoPath: string;
    repoFullName: string;
  } | null>(null);

  useEffect(() => {
    if (answers.envKey || !envs?.length) return;
    setAnswers((a) => ({ ...a, envKey: envs[0]!.key }));
  }, [envs, answers.envKey]);

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({
    value: e.key,
    label: e.name || e.key,
  }));
  const regionOptions: SelectOption[] = useMemo(
    () => AWS_REGIONS.map((r) => ({ value: r, label: r })),
    [],
  );

  const errors: Partial<Record<keyof Answers, string>> = {};
  if (pageIdx === 0) {
    const n = answers.name.trim();
    if (!n) errors.name = "Required.";
    else if (!/^[a-z][a-z0-9-]{1,40}$/.test(n))
      errors.name = "Lowercase, dashes, 2-41 chars, starts with a letter.";
    if (!answers.region) errors.region = "Pick a region.";
    if (!answers.envKey) errors.envKey = "Pick an env.";
    if (!CIDR_RE.test(answers.vpcCidr.trim()))
      errors.vpcCidr = "Not a valid IPv4 CIDR (e.g. 10.0.0.0/16).";
  }
  // Pages 1 and 2 use dropdowns/checkboxes — no free-form validation needed.
  const pageHasError = Object.keys(errors).length > 0;
  const onReview = pageIdx === PAGE_TITLES.length - 1;

  function next() {
    if (pageHasError) return;
    setPageIdx((i) => Math.min(PAGE_TITLES.length - 1, i + 1));
  }
  function back() {
    setPageIdx((i) => Math.max(0, i - 1));
  }

  async function handleCreate() {
    setServerError(null);
    try {
      const res = await submit.mutateAsync({
        name: answers.name.trim(),
        envKey: answers.envKey,
        region: answers.region,
        vpcCidr: answers.vpcCidr.trim(),
        azCount: answers.azCount,
        includePrivateSubnets: answers.includePrivateSubnets,
        // Server ignores natStrategy when includePrivateSubnets=false, but
        // send the current picker value anyway for auditability.
        natStrategy: answers.includePrivateSubnets ? answers.natStrategy : "none",
        dnsHostnames: answers.dnsHostnames,
        dnsSupport: answers.dnsSupport,
      });
      if (res.approvalId) {
        setResult({
          approvalId: res.approvalId,
          repoPath: res.repoPath ?? "",
          repoFullName: res.repoFullName ?? "",
        });
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "VPC submit failed.");
    }
  }

  if (result) {
    return (
      <Block>
        <Block.Header>
          <Block.Title
            sub={`Files committed to ${result.repoFullName}/${result.repoPath}. Approve below to run terraform apply.`}
          >
            VPC submitted — pending approval
          </Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="col gap-3">
            <ApprovalCard slug={slug} approvalId={result.approvalId} />
          </div>
        </Block.Body>
      </Block>
    );
  }

  const totalSteps = PAGE_TITLES.length;
  const stepLabel = `Step ${pageIdx + 1} of ${totalSteps} · ${PAGE_TITLES[pageIdx]}`;
  const previewSubnetCount = answers.azCount * (answers.includePrivateSubnets ? 2 : 1);
  const natCount =
    !answers.includePrivateSubnets || answers.natStrategy === "none"
      ? 0
      : answers.natStrategy === "per_az"
        ? answers.azCount
        : 1;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Console-style VPC creation. Multi-AZ with optional private subnets and NAT gateways.">
          Create VPC
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-4" style={{ maxWidth: 640 }}>
          <div className="row gap-2" style={{ alignItems: "center" }}>
            {Array.from({ length: totalSteps }).map((_, i) => (
              <span
                key={i}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background: i <= pageIdx ? "var(--accent, #5b8cff)" : "var(--surface-3, #00000018)",
                }}
              />
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
            {stepLabel}
          </span>

          {pageIdx === 0 && (
            <div className="col gap-3">
              <Field
                label="Name prefix"
                required
                hint="Lowercase, dashes. Used to tag every resource this stack creates."
                error={errors.name}
              >
                <Input
                  value={answers.name}
                  onChange={(e) => setAnswers((a) => ({ ...a, name: e.target.value }))}
                  className="mono"
                />
              </Field>
              <Field label="Region" required error={errors.region}>
                <Select
                  options={regionOptions}
                  value={answers.region}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, region: v }))}
                  ariaLabel="Region"
                />
              </Field>
              <Field label="Environment" required error={errors.envKey}>
                <Select
                  options={envOptions}
                  value={answers.envKey}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, envKey: v }))}
                  ariaLabel="Environment"
                  placeholder="Pick an env…"
                />
              </Field>
              <Field
                label="VPC CIDR"
                required
                hint="Use DISTINCT CIDRs if you plan to peer VPCs across regions later. Subnet CIDRs are auto-carved from this /16."
                error={errors.vpcCidr}
              >
                <Input
                  value={answers.vpcCidr}
                  onChange={(e) => setAnswers((a) => ({ ...a, vpcCidr: e.target.value }))}
                  className="mono"
                />
              </Field>
            </div>
          )}

          {pageIdx === 1 && (
            <div className="col gap-3">
              <Field
                label="Availability Zones"
                required
                hint="More AZs = higher availability but more subnets to manage. 2 is the standard baseline."
              >
                <Select
                  options={AZ_OPTIONS}
                  value={String(answers.azCount)}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, azCount: Number(v) as 1 | 2 | 3 }))}
                  ariaLabel="AZ count"
                />
              </Field>
              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 4 }}>DNS options</div>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={answers.dnsSupport}
                  onChange={(e) => setAnswers((a) => ({ ...a, dnsSupport: e.target.checked }))}
                />
                <span>Enable DNS resolution (Route53 resolver — recommended)</span>
              </label>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={answers.dnsHostnames}
                  onChange={(e) => setAnswers((a) => ({ ...a, dnsHostnames: e.target.checked }))}
                />
                <span>Enable DNS hostnames (auto-assign public DNS names — recommended)</span>
              </label>
            </div>
          )}

          {pageIdx === 2 && (
            <div className="col gap-3">
              <div style={{ fontWeight: 600, fontSize: 13 }}>Subnets</div>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={answers.includePrivateSubnets}
                  onChange={(e) =>
                    setAnswers((a) => ({ ...a, includePrivateSubnets: e.target.checked }))
                  }
                />
                <span>
                  Also create one private subnet per AZ (recommended — internal-only workloads live here)
                </span>
              </label>
              <div className="muted" style={{ fontSize: 12 }}>
                Public subnets get a route to the internet gateway. Private subnets have no default
                route unless you add NAT below.
              </div>

              {answers.includePrivateSubnets && (
                <>
                  <div style={{ fontWeight: 600, fontSize: 13, marginTop: 4 }}>
                    NAT gateway strategy
                  </div>
                  <Field
                    label="NAT for private subnets"
                    hint="NAT lets private subnets reach the internet outbound (package downloads, API calls) without being reachable inbound. Cost is per gateway per hour."
                  >
                    <Select
                      options={NAT_OPTIONS}
                      value={answers.natStrategy}
                      onValueChange={(v) => setAnswers((a) => ({ ...a, natStrategy: v as NatStrategy }))}
                      ariaLabel="NAT strategy"
                    />
                  </Field>
                  {answers.natStrategy === "none" && (
                    <div
                      className="row gap-2"
                      style={{
                        padding: 10,
                        borderRadius: 8,
                        background: "var(--warn-soft)",
                        color: "var(--warn)",
                        fontSize: 12.5,
                      }}
                      role="alert"
                    >
                      <span>
                        Private subnets will have no outbound internet. Fine for pure internal
                        workloads; add a NAT later if you need it.
                      </span>
                    </div>
                  )}
                </>
              )}
              <div
                className="muted"
                style={{ fontSize: 12, marginTop: 6, padding: 10, background: "var(--surface-2)", borderRadius: 8 }}
              >
                Preview: {answers.azCount} AZ{answers.azCount === 1 ? "" : "s"} ·{" "}
                {previewSubnetCount} subnet{previewSubnetCount === 1 ? "" : "s"}
                {natCount > 0 ? ` · ${natCount} NAT gateway${natCount === 1 ? "" : "s"}` : ""}.
                Subnet CIDRs auto-carved from {answers.vpcCidr} as /20 slices.
              </div>
            </div>
          )}

          {onReview && (
            <div className="col gap-3">
              <div
                className="col gap-1"
                style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}
              >
                <ReviewRow label="Name" value={answers.name} />
                <ReviewRow label="Region" value={answers.region} />
                <ReviewRow
                  label="Environment"
                  value={envs?.find((e) => e.key === answers.envKey)?.name ?? answers.envKey}
                />
                <ReviewRow label="VPC CIDR" value={answers.vpcCidr} />
                <ReviewRow label="Availability Zones" value={String(answers.azCount)} />
                <ReviewRow
                  label="Subnets"
                  value={`${answers.azCount} public${answers.includePrivateSubnets ? ` + ${answers.azCount} private` : ""}`}
                />
                {answers.includePrivateSubnets && (
                  <ReviewRow
                    label="NAT strategy"
                    value={
                      answers.natStrategy === "none"
                        ? "None (private isolated)"
                        : answers.natStrategy === "single"
                          ? "Single shared NAT"
                          : `Per-AZ NAT (${answers.azCount})`
                    }
                  />
                )}
                <ReviewRow
                  label="DNS"
                  value={
                    (answers.dnsSupport ? "resolution ✓" : "resolution ✗") +
                    " · " +
                    (answers.dnsHostnames ? "hostnames ✓" : "hostnames ✗")
                  }
                />
              </div>
              {serverError && (
                <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
                  {serverError}
                </p>
              )}
            </div>
          )}

          <div className="row gap-2" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <Btn variant="ghost" onClick={back} disabled={pageIdx === 0 || submit.isPending}>
              Back
            </Btn>
            {onReview ? (
              <Btn
                variant="primary"
                icon="plus"
                loading={submit.isPending}
                onClick={handleCreate}
              >
                Create VPC
              </Btn>
            ) : (
              <Btn variant="primary" onClick={next} disabled={pageHasError}>
                Next
              </Btn>
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
