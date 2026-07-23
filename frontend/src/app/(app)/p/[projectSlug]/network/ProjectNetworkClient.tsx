"use client";

import { useEffect, useState } from "react";
import { Badge, Block, Btn, Field, Input, PageHead, Select, type SelectOption } from "@/components/ui";
import { InlineApprovalResult } from "@/components/domain/InlineApprovalResult";
import { useProjectEnvs } from "@/hooks/queries/project";
import { useAwsVpcsInRegion, useSubmitVpcPeering } from "@/hooks/queries/network";
// Shared with the chat wizards + Storage page — see lib/aws-regions.ts.
import { AWS_REGIONS as COMMON_REGIONS } from "@/lib/aws-regions";

/**
 * Network — cross-region VPC peering, driven by a two-column region+VPC
 * picker. VPC and EC2 creation used to live here as sibling tabs; those
 * moved to the chat wizards (`vpc-create` and `ec2-create` fences), which
 * offer the same fields with paged UX. Kept as a top-level sidebar page
 * because peering doesn't fit cleanly in the chat wizard shape (two
 * regions worth of dropdowns side-by-side is a UI-native interaction).
 */
const REGION_OPTIONS: SelectOption[] = COMMON_REGIONS.map((r) => ({ value: r, label: r }));

export function ProjectNetworkClient({ slug }: { slug: string }) {
  return (
    <div className="col gap-5">
      <PageHead
        title="Network"
        sub="Cross-region VPC peering — pick a VPC from two different regions to connect them."
      />
      <PeeringPanel slug={slug} />
    </div>
  );
}

// ── Peering panel ─────────────────────────────────────────────────────────

function PeeringPanel({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const [leftRegion, setLeftRegion] = useState<string>("");
  const [leftVpcId, setLeftVpcId] = useState<string>("");
  const [rightRegion, setRightRegion] = useState<string>("");
  const [rightVpcId, setRightVpcId] = useState<string>("");
  const [envKey, setEnvKey] = useState<string>("");
  const [name, setName] = useState<string>("cross-region-peer");
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<{ approvalId: string; repoPath: string; repoFullName: string } | null>(
    null,
  );

  const submit = useSubmitVpcPeering(slug);
  const leftVpcs = useAwsVpcsInRegion(slug, leftRegion || null);
  const rightVpcs = useAwsVpcsInRegion(slug, rightRegion || null);

  useEffect(() => setLeftVpcId(""), [leftRegion]);
  useEffect(() => setRightVpcId(""), [rightRegion]);
  useEffect(() => {
    if (envKey || !envs?.length) return;
    setEnvKey(envs[0]!.key);
  }, [envs, envKey]);

  const leftPicked =
    leftVpcs.data && "vpcs" in leftVpcs.data
      ? leftVpcs.data.vpcs.find((v) => v.vpcId === leftVpcId)
      : undefined;
  const rightPicked =
    rightVpcs.data && "vpcs" in rightVpcs.data
      ? rightVpcs.data.vpcs.find((v) => v.vpcId === rightVpcId)
      : undefined;

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({
    value: e.key,
    label: e.isProduction ? `${e.name} (prod)` : e.name || e.key,
  }));

  const sameRegion = !!leftRegion && leftRegion === rightRegion;
  const sameVpc = !!leftVpcId && leftVpcId === rightVpcId;
  const sameCidr = !!leftPicked?.cidr && leftPicked.cidr === rightPicked?.cidr;
  const ready =
    !!leftRegion &&
    !!rightRegion &&
    !!leftPicked?.cidr &&
    !!rightPicked?.cidr &&
    !!envKey &&
    !!name.trim() &&
    !sameRegion &&
    !sameVpc &&
    !sameCidr;

  async function handleSubmit() {
    if (!ready || !leftPicked || !rightPicked) return;
    setServerError(null);
    try {
      const res = await submit.mutateAsync({
        name: name.trim(),
        envKey,
        left: { region: leftRegion, vpcId: leftPicked.vpcId, cidr: leftPicked.cidr },
        right: { region: rightRegion, vpcId: rightPicked.vpcId, cidr: rightPicked.cidr },
      });
      if (res.approvalId) {
        setResult({
          approvalId: res.approvalId,
          repoPath: res.repoPath ?? "",
          repoFullName: res.repoFullName ?? "",
        });
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Peering submit failed.");
    }
  }

  if (result) {
    return (
      <InlineApprovalResult
        slug={slug}
        approvalId={result.approvalId}
        repoFullName={result.repoFullName}
        repoPath={result.repoPath}
        resetLabel="New peering"
        onReset={() => {
          setResult(null);
          setName("cross-region-peer");
        }}
      />
    );
  }

  return (
    <div className="col gap-4">
      <Block>
        <Block.Header>
          <Block.Title sub="Pick a VPC from two different regions. Non-overlapping CIDRs required.">
            Cross-region VPC peering
          </Block.Title>
        </Block.Header>
      </Block>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <VpcColumn
          title="LEFT (requester)"
          regionValue={leftRegion}
          onRegionChange={setLeftRegion}
          vpcsQuery={leftVpcs}
          vpcId={leftVpcId}
          onVpcChange={setLeftVpcId}
        />
        <VpcColumn
          title="RIGHT (accepter)"
          regionValue={rightRegion}
          onRegionChange={setRightRegion}
          vpcsQuery={rightVpcs}
          vpcId={rightVpcId}
          onVpcChange={setRightVpcId}
        />
      </div>

      <Block>
        <div className="col gap-3" style={{ padding: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
            <Field label="Peering name" required hint="Lowercase, dashes. Used as the Terraform stack name.">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="cross-region-peer"
                className="mono"
              />
            </Field>
            <Field label="Environment" required hint="For tagging + approval routing.">
              <Select
                options={envOptions}
                value={envKey}
                onValueChange={setEnvKey}
                ariaLabel="Environment"
                placeholder="Pick an env…"
              />
            </Field>
          </div>

          {(sameRegion || sameVpc || sameCidr) && (
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
              {sameRegion && (
                <span>
                  Both sides are in the same region — cross-region peering needs two different regions.
                </span>
              )}
              {sameVpc && <span>Both sides picked the same VPC — pick two different VPCs.</span>}
              {sameCidr && !sameVpc && (
                <span>
                  Both VPCs use the same CIDR ({leftPicked?.cidr}). Peered VPCs must have non-overlapping
                  CIDRs.
                </span>
              )}
            </div>
          )}

          {serverError && (
            <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
              {serverError}
            </p>
          )}

          <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
            <Btn
              variant="primary"
              icon="link"
              loading={submit.isPending}
              disabled={!ready || submit.isPending}
              onClick={handleSubmit}
            >
              Peer these VPCs
            </Btn>
          </div>
        </div>
      </Block>
    </div>
  );
}

// ── VpcColumn — region + VPC picker for one side ─────────────────────────

type VpcsQueryLike = ReturnType<typeof useAwsVpcsInRegion>;

function VpcColumn({
  title,
  regionValue,
  onRegionChange,
  vpcsQuery,
  vpcId,
  onVpcChange,
}: {
  title: string;
  regionValue: string;
  onRegionChange: (v: string) => void;
  vpcsQuery: VpcsQueryLike;
  vpcId: string;
  onVpcChange: (v: string) => void;
}) {
  const list = vpcsQuery.data && "vpcs" in vpcsQuery.data ? vpcsQuery.data.vpcs : [];
  const disconnectNote =
    vpcsQuery.data && !("connected" in vpcsQuery.data && vpcsQuery.data.connected)
      ? (vpcsQuery.data as { note?: string }).note ?? null
      : null;
  const vpcOptions: SelectOption[] = list.map((v) => ({
    value: v.vpcId,
    label: `${v.vpcId} · ${v.cidr}${v.name ? ` · ${v.name}` : ""}${v.isDefault ? " (default)" : ""}`,
  }));
  const picked = list.find((v) => v.vpcId === vpcId);

  return (
    <Block>
      <Block.Header>
        <Block.Title>{title}</Block.Title>
      </Block.Header>
      <div className="col gap-3" style={{ padding: 4 }}>
        <Field label="Region" required>
          <Select
            options={REGION_OPTIONS}
            value={regionValue}
            onValueChange={onRegionChange}
            ariaLabel={`${title} region`}
            placeholder="Pick a region…"
          />
        </Field>
        <Field
          label="VPC"
          required
          hint={
            !regionValue
              ? "Pick a region first."
              : vpcsQuery.isLoading
                ? "Loading VPCs…"
                : disconnectNote
                  ? disconnectNote
                  : list.length === 0
                    ? "No VPCs in this region."
                    : `${list.length} VPC${list.length === 1 ? "" : "s"} in ${regionValue}.`
          }
        >
          <Select
            options={vpcOptions}
            value={vpcId}
            onValueChange={onVpcChange}
            ariaLabel={`${title} VPC`}
            placeholder="Pick a VPC…"
            disabled={!regionValue || vpcOptions.length === 0}
          />
        </Field>
        {picked && (
          <div className="row gap-2 wrap" style={{ fontSize: 12 }}>
            <Badge tone="info">CIDR</Badge>
            <span className="mono">{picked.cidr}</span>
            {picked.name && (
              <>
                <Badge>Name</Badge>
                <span>{picked.name}</span>
              </>
            )}
            {picked.isDefault && <Badge tone="warn">default VPC</Badge>}
          </div>
        )}
      </div>
    </Block>
  );
}
