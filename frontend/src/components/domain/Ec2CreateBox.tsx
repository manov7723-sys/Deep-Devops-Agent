"use client";

/**
 * EC2 creation wizard, embedded in chat via the ```ec2-create``` fence.
 * Console-style paged wizard mirroring the sections of AWS's own "Launch
 * an instance" flow:
 *
 *   Page 1 · Name & basics         name, region, env, custom tags
 *   Page 2 · Image & login         AMI family (7 options), key pair name
 *   Page 3 · Network & firewall    VPC, subnet, SSH source CIDR, HTTP,
 *                                  HTTPS
 *   Page 4 · Compute & storage     instance type (with vCPU/RAM/pricing
 *                                  hint), root volume type (gp3/gp2/io2),
 *                                  size, IOPS, encryption
 *   Page 5 · Advanced              user data (bash on first boot)
 *   Page 6 · Review                everything summarized, Launch button
 *
 * No LLM once the fence is emitted; this component owns the flow through
 * the inline ApprovalCard.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Block,
  Btn,
  Field,
  Input,
  Select,
  Textarea,
  type SelectOption,
} from "@/components/ui";
import { ApprovalCard } from "@/components/domain/ApprovalCard";
import { useProjectEnvs } from "@/hooks/queries/project";
import {
  useAwsVpcsInRegion,
  useAwsSubnetsInVpc,
  useSubmitEc2,
} from "@/hooks/queries/network";

// Shared across every AWS picker in the app — see lib/aws-regions.ts.
import { AWS_REGIONS } from "@/lib/aws-regions";

const AMI_OPTIONS: SelectOption[] = [
  { value: "al2023", label: "Amazon Linux 2023" },
  { value: "ubuntu-22.04", label: "Ubuntu 22.04 LTS" },
  { value: "ubuntu-24.04", label: "Ubuntu 24.04 LTS" },
  { value: "windows-2022", label: "Windows Server 2022" },
  { value: "rhel-9", label: "Red Hat Enterprise Linux 9" },
  { value: "sles-15", label: "SUSE Linux Enterprise Server 15" },
  { value: "debian-12", label: "Debian 12" },
];

// Instance type label carries vCPU / RAM so the picker feels like AWS's
// console table. Pricing is on-demand Linux in us-east-1 as a rough anchor —
// real cost varies by region and by AMI family (Windows/RHEL cost more).
const INSTANCE_TYPE_OPTIONS: SelectOption[] = [
  { value: "t3.micro", label: "t3.micro — 2 vCPU · 1 GB · ~$0.0104/hr Linux (Free-tier)" },
  { value: "t3.small", label: "t3.small — 2 vCPU · 2 GB · ~$0.0208/hr" },
  { value: "t3.medium", label: "t3.medium — 2 vCPU · 4 GB · ~$0.0416/hr" },
  { value: "t3.large", label: "t3.large — 2 vCPU · 8 GB · ~$0.0832/hr" },
  { value: "t3.xlarge", label: "t3.xlarge — 4 vCPU · 16 GB · ~$0.1664/hr" },
  { value: "m5.large", label: "m5.large — 2 vCPU · 8 GB · ~$0.096/hr" },
  { value: "m5.xlarge", label: "m5.xlarge — 4 vCPU · 16 GB · ~$0.192/hr" },
  { value: "m5.2xlarge", label: "m5.2xlarge — 8 vCPU · 32 GB · ~$0.384/hr" },
];

const VOLUME_TYPE_OPTIONS: SelectOption[] = [
  { value: "gp3", label: "gp3 (General Purpose SSD — recommended)" },
  { value: "gp2", label: "gp2 (General Purpose SSD — legacy)" },
  { value: "io2", label: "io2 (Provisioned IOPS SSD — high perf)" },
];

// Windows AMIs REQUIRE a key pair (no SSM enrollment on first boot without
// one) — surface that in the label so the user picks correctly.
const IS_WINDOWS_AMI = (v: string) => v === "windows-2022";

type Tag = { key: string; value: string };
type Answers = {
  name: string;
  region: string;
  envKey: string;
  vpcId: string;
  subnetId: string;
  ami: string;
  sshKeyName: string;
  sshCidr: string; // "" = SSM only; else literal CIDR
  allowHttp: boolean;
  allowHttps: boolean;
  instanceType: string;
  diskGb: string;
  volumeType: string;
  volumeIops: string; // string for form input; parsed to number on submit
  encryptVolume: boolean;
  userData: string;
  tags: Tag[];
};

const PAGE_TITLES = [
  "Name & basics",
  "Image & login",
  "Network & firewall",
  "Compute & storage",
  "Advanced",
  "Review",
];

export function Ec2CreateBox({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const submit = useSubmitEc2(slug);

  const [answers, setAnswers] = useState<Answers>({
    name: "linux-box",
    region: "us-east-1",
    envKey: "",
    vpcId: "",
    subnetId: "",
    ami: "al2023",
    sshKeyName: "",
    sshCidr: "",
    allowHttp: false,
    allowHttps: false,
    instanceType: "t3.micro",
    diskGb: "20",
    volumeType: "gp3",
    volumeIops: "",
    encryptVolume: true,
    userData: "",
    tags: [],
  });
  const [pageIdx, setPageIdx] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    approvalId: string;
    repoPath: string;
    repoFullName: string;
  } | null>(null);

  const vpcs = useAwsVpcsInRegion(slug, answers.region || null);
  const subnets = useAwsSubnetsInVpc(slug, answers.region || null, answers.vpcId || null);

  useEffect(() => {
    if (answers.envKey || !envs?.length) return;
    setAnswers((a) => ({ ...a, envKey: envs[0]!.key }));
  }, [envs, answers.envKey]);

  function setRegion(r: string) {
    setAnswers((a) => ({ ...a, region: r, vpcId: "", subnetId: "" }));
  }
  function setVpcId(v: string) {
    setAnswers((a) => ({ ...a, vpcId: v, subnetId: "" }));
  }
  function patchTag(i: number, patch: Partial<Tag>) {
    setAnswers((a) => ({ ...a, tags: a.tags.map((t, j) => (i === j ? { ...t, ...patch } : t)) }));
  }
  function addTag() {
    setAnswers((a) => ({ ...a, tags: [...a.tags, { key: "", value: "" }] }));
  }
  function removeTag(i: number) {
    setAnswers((a) => ({ ...a, tags: a.tags.filter((_, j) => j !== i) }));
  }

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({
    value: e.key,
    label: e.name || e.key,
  }));
  const regionOptions: SelectOption[] = useMemo(
    () => AWS_REGIONS.map((r) => ({ value: r, label: r })),
    [],
  );
  const vpcList = vpcs.data && "vpcs" in vpcs.data ? vpcs.data.vpcs : [];
  const vpcOptions: SelectOption[] = vpcList.map((v) => ({
    value: v.vpcId,
    label: `${v.vpcId} · ${v.cidr}${v.name ? ` · ${v.name}` : ""}${v.isDefault ? " (default)" : ""}`,
  }));
  const subnetList = subnets.data?.subnets ?? [];
  const subnetOptions: SelectOption[] = subnetList.map((s) => ({
    value: s.subnetId,
    label: `${s.subnetId} · ${s.cidr} · ${s.az}${s.isPublic ? " · public" : " · private"}${s.name ? ` · ${s.name}` : ""}`,
  }));
  const pickedSubnet = subnetList.find((s) => s.subnetId === answers.subnetId);
  const windowsPicked = IS_WINDOWS_AMI(answers.ami);
  const hasIops = answers.volumeType === "gp3" || answers.volumeType === "io2";

  // Per-page validation — very light; server does the strict checks.
  const errors: Partial<Record<keyof Answers, string>> = {};
  if (pageIdx === 0) {
    if (!answers.name.trim()) errors.name = "Required.";
    else if (!/^[a-z][a-z0-9-]{1,40}$/.test(answers.name.trim()))
      errors.name = "Lowercase, dashes, 2-41 chars, starts with a letter.";
    if (!answers.region) errors.region = "Pick a region.";
    if (!answers.envKey) errors.envKey = "Pick an env.";
    if (answers.tags.some((t) => (t.key && !t.value) || (!t.key && t.value)))
      errors.tags = "Every tag needs both a key and a value (delete rows you don't need).";
  }
  if (pageIdx === 1) {
    if (!answers.ami) errors.ami = "Pick an OS.";
    if (windowsPicked && !answers.sshKeyName.trim())
      errors.sshKeyName = "Windows Server requires a key pair — SSM can't shell in without one.";
  }
  if (pageIdx === 2) {
    if (!answers.vpcId) errors.vpcId = "Pick a VPC.";
    if (!answers.subnetId) errors.subnetId = "Pick a subnet.";
    if (answers.sshCidr.trim() && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(answers.sshCidr.trim()))
      errors.sshCidr = "Not a valid CIDR (e.g. 203.0.113.5/32 or 0.0.0.0/0).";
    // Deliberately DON'T require a key pair here even when SSH is open — SSM
    // Session Manager still works without one, so the instance stays reachable
    // even in that odd config. A soft warning appears inline instead. Blocking
    // Next with an error on a field that lives on ANOTHER page (sshKeyName is
    // on Page 2) would silently disable Next with no visible cause.
  }
  if (pageIdx === 3) {
    if (!answers.instanceType) errors.instanceType = "Pick an instance type.";
    const n = Number(answers.diskGb);
    if (!Number.isFinite(n) || n < 8) errors.diskGb = "At least 8 GB.";
    if (answers.volumeIops.trim()) {
      const iops = Number(answers.volumeIops);
      if (!Number.isFinite(iops) || iops < 100) errors.volumeIops = "At least 100.";
    }
  }
  const pageHasError = Object.keys(errors).length > 0;
  const onReview = pageIdx === PAGE_TITLES.length - 1;

  function next() {
    if (pageHasError) return;
    setPageIdx((i) => Math.min(PAGE_TITLES.length - 1, i + 1));
  }
  function back() {
    setPageIdx((i) => Math.max(0, i - 1));
  }

  async function handleLaunch() {
    setServerError(null);
    try {
      // Compact the tags list into a { key: value } object, filtering blanks.
      const customTags: Record<string, string> = {};
      for (const t of answers.tags) {
        const k = t.key.trim();
        const v = t.value.trim();
        if (k && v) customTags[k] = v;
      }
      const res = await submit.mutateAsync({
        name: answers.name.trim(),
        envKey: answers.envKey,
        region: answers.region,
        vpcId: answers.vpcId,
        subnetId: answers.subnetId,
        ami: answers.ami as SubmitAmi,
        instanceType: answers.instanceType,
        diskGb: Number(answers.diskGb),
        volumeType: answers.volumeType as "gp3" | "gp2" | "io2",
        volumeIops: hasIops && answers.volumeIops.trim() ? Number(answers.volumeIops) : undefined,
        encryptVolume: answers.encryptVolume,
        sshCidr: answers.sshCidr.trim() || undefined,
        sshKeyName: answers.sshKeyName.trim() || undefined,
        allowHttp: answers.allowHttp,
        allowHttps: answers.allowHttps,
        userData: answers.userData.trim() || undefined,
        customTags: Object.keys(customTags).length > 0 ? customTags : undefined,
      });
      if (res.approvalId) {
        setResult({
          approvalId: res.approvalId,
          repoPath: res.repoPath ?? "",
          repoFullName: res.repoFullName ?? "",
        });
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "EC2 submit failed.");
    }
  }

  if (result) {
    return (
      <Block>
        <Block.Header>
          <Block.Title
            sub={`Files committed to ${result.repoFullName}/${result.repoPath}. Approve below to run terraform apply.`}
          >
            EC2 submitted — pending approval
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

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Console-style EC2 launch wizard. All the fields the AWS console exposes, paged for clarity.">
          Launch an instance
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-4" style={{ maxWidth: 640 }}>
          {/* Stepper */}
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

          {/* Page 1 · Name & basics */}
          {pageIdx === 0 && (
            <div className="col gap-3">
              <Field
                label="Name"
                required
                hint="Lowercase, dashes. Used as the Name tag and stack name."
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
                  onValueChange={setRegion}
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
                label="Additional tags"
                hint="Optional. Merged on top of ManagedBy / Stack / Environment / Name."
                error={errors.tags}
              >
                <div className="col gap-2">
                  {answers.tags.map((t, i) => (
                    <div
                      key={i}
                      className="row gap-2"
                      style={{ alignItems: "center" }}
                    >
                      <Input
                        placeholder="key (e.g. CostCenter)"
                        value={t.key}
                        onChange={(e) => patchTag(i, { key: e.target.value })}
                        className="mono"
                        style={{ flex: 1 }}
                      />
                      <Input
                        placeholder="value"
                        value={t.value}
                        onChange={(e) => patchTag(i, { value: e.target.value })}
                        className="mono"
                        style={{ flex: 1 }}
                      />
                      <Btn variant="ghost" icon="trash" onClick={() => removeTag(i)} aria-label="Remove tag" />
                    </div>
                  ))}
                  <div>
                    <Btn variant="outline" icon="plus" onClick={addTag} size="sm">
                      Add tag
                    </Btn>
                  </div>
                </div>
              </Field>
            </div>
          )}

          {/* Page 2 · Image & login */}
          {pageIdx === 1 && (
            <div className="col gap-3">
              <Field
                label="Application and OS image (AMI)"
                required
                hint="Latest available image per family is picked automatically at apply time."
                error={errors.ami}
              >
                <Select
                  options={AMI_OPTIONS}
                  value={answers.ami}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, ami: v }))}
                  ariaLabel="AMI"
                />
              </Field>
              {windowsPicked && (
                <div
                  className="row gap-2"
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    background: "var(--warn-soft)",
                    color: "var(--warn)",
                    fontSize: 12.5,
                  }}
                >
                  Windows Server needs a key pair — the initial Administrator password is
                  retrieved by decrypting with this key.
                </div>
              )}
              <Field
                label="Key pair name"
                required={windowsPicked}
                hint="An EXISTING EC2 key pair in this account+region. Leave empty for Linux + SSM only."
                error={errors.sshKeyName}
              >
                <Input
                  value={answers.sshKeyName}
                  onChange={(e) => setAnswers((a) => ({ ...a, sshKeyName: e.target.value }))}
                  className="mono"
                  placeholder="my-keypair"
                />
              </Field>
            </div>
          )}

          {/* Page 3 · Network & firewall */}
          {pageIdx === 2 && (
            <div className="col gap-3">
              <Field
                label="VPC"
                required
                error={errors.vpcId}
                hint={
                  vpcs.isLoading
                    ? "Loading VPCs…"
                    : vpcList.length === 0
                      ? `No VPCs in ${answers.region}. Create one on the Network > VPCs page first.`
                      : `${vpcList.length} VPC${vpcList.length === 1 ? "" : "s"} in ${answers.region}.`
                }
              >
                <Select
                  options={vpcOptions}
                  value={answers.vpcId}
                  onValueChange={setVpcId}
                  ariaLabel="VPC"
                  placeholder="Pick a VPC…"
                  disabled={vpcOptions.length === 0}
                />
              </Field>
              <Field
                label="Subnet"
                required
                error={errors.subnetId}
                hint={
                  !answers.vpcId
                    ? "Pick a VPC first."
                    : subnets.isLoading
                      ? "Loading subnets…"
                      : subnetList.length === 0
                        ? "No subnets in that VPC."
                        : `${subnetList.length} subnet${subnetList.length === 1 ? "" : "s"}.`
                }
              >
                <Select
                  options={subnetOptions}
                  value={answers.subnetId}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, subnetId: v }))}
                  ariaLabel="Subnet"
                  placeholder="Pick a subnet…"
                  disabled={!answers.vpcId || subnetOptions.length === 0}
                />
              </Field>
              {pickedSubnet && (
                <div className="row gap-2 wrap" style={{ fontSize: 12 }}>
                  <Badge tone="info">CIDR</Badge>
                  <span className="mono">{pickedSubnet.cidr}</span>
                  <Badge>AZ</Badge>
                  <span>{pickedSubnet.az}</span>
                  <Badge tone={pickedSubnet.isPublic ? "ok" : "warn"}>
                    {pickedSubnet.isPublic ? "public" : "private"}
                  </Badge>
                </div>
              )}
              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 4 }}>
                Firewall (security group)
              </div>
              {/* SSH-from-anywhere checkbox is a QUICK toggle that pins the
                  CIDR field to 0.0.0.0/0. Derived from sshCidr so there's no
                  state duplication — untick it (or edit the CIDR to
                  something else) and the box updates itself. */}
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={answers.sshCidr.trim() === "0.0.0.0/0"}
                  onChange={(e) =>
                    setAnswers((a) => ({ ...a, sshCidr: e.target.checked ? "0.0.0.0/0" : "" }))
                  }
                />
                <span>Allow SSH (TCP/22) from anywhere — WARNING: open to the entire internet</span>
              </label>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={answers.allowHttp}
                  onChange={(e) => setAnswers((a) => ({ ...a, allowHttp: e.target.checked }))}
                />
                <span>Allow HTTP (TCP/80) from the internet — for web servers</span>
              </label>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={answers.allowHttps}
                  onChange={(e) => setAnswers((a) => ({ ...a, allowHttps: e.target.checked }))}
                />
                <span>Allow HTTPS (TCP/443) from the internet — for web servers</span>
              </label>
              <Field
                label="Or restrict SSH to a specific CIDR"
                hint="Optional. Empty = no SSH ingress (SSM shell-in still works). Prefer '<your-ip>/32' over the checkbox above."
                error={errors.sshCidr}
              >
                <Input
                  value={answers.sshCidr}
                  onChange={(e) => setAnswers((a) => ({ ...a, sshCidr: e.target.value }))}
                  className="mono"
                  placeholder="203.0.113.5/32"
                />
              </Field>
              {answers.sshCidr.trim() && !answers.sshKeyName.trim() && (
                <div
                  className="row gap-2"
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    background: "var(--warn-soft)",
                    color: "var(--warn)",
                    fontSize: 12.5,
                  }}
                >
                  Heads-up: SSH port is open but no key pair is set (Page 2 — Image & login).
                  You&apos;ll be able to reach the box via SSM Session Manager but not SSH — go
                  back and add a key pair if you actually want to SSH in.
                </div>
              )}
            </div>
          )}

          {/* Page 4 · Compute & storage */}
          {pageIdx === 3 && (
            <div className="col gap-3">
              <Field
                label="Instance type"
                required
                hint="Pricing shown is on-demand Linux in us-east-1 — real cost varies by region and OS."
                error={errors.instanceType}
              >
                <Select
                  options={INSTANCE_TYPE_OPTIONS}
                  value={answers.instanceType}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, instanceType: v }))}
                  ariaLabel="Instance type"
                />
              </Field>
              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 4 }}>
                Configure storage (root EBS)
              </div>
              <Field label="Volume type" required>
                <Select
                  options={VOLUME_TYPE_OPTIONS}
                  value={answers.volumeType}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, volumeType: v }))}
                  ariaLabel="Volume type"
                />
              </Field>
              <Field label="Size (GiB)" required error={errors.diskGb}>
                <Input
                  type="number"
                  min={8}
                  value={answers.diskGb}
                  onChange={(e) => setAnswers((a) => ({ ...a, diskGb: e.target.value }))}
                  className="mono"
                />
              </Field>
              {hasIops && (
                <Field
                  label="IOPS"
                  hint="Leave empty for the AWS default (3000 for gp3, 100 for io2). gp3 supports up to 16000."
                  error={errors.volumeIops}
                >
                  <Input
                    type="number"
                    min={100}
                    value={answers.volumeIops}
                    onChange={(e) => setAnswers((a) => ({ ...a, volumeIops: e.target.value }))}
                    className="mono"
                  />
                </Field>
              )}
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={answers.encryptVolume}
                  onChange={(e) => setAnswers((a) => ({ ...a, encryptVolume: e.target.checked }))}
                />
                <span>Encrypt volume (recommended — uses AWS-managed KMS key)</span>
              </label>
            </div>
          )}

          {/* Page 5 · Advanced */}
          {pageIdx === 4 && (
            <div className="col gap-3">
              <Field
                label="User data (runs on first boot as root)"
                hint="Bash script for Linux, or PowerShell/cmd for Windows. Optional. Terraform base64-encodes it."
              >
                <Textarea
                  value={answers.userData}
                  onChange={(e) => setAnswers((a) => ({ ...a, userData: e.target.value }))}
                  className="mono"
                  rows={8}
                  placeholder={"#!/bin/bash\nyum install -y nginx\nsystemctl enable --now nginx"}
                />
              </Field>
            </div>
          )}

          {/* Review */}
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
                {answers.tags.filter((t) => t.key && t.value).length > 0 && (
                  <ReviewRow
                    label="Extra tags"
                    value={answers.tags
                      .filter((t) => t.key && t.value)
                      .map((t) => `${t.key}=${t.value}`)
                      .join(", ")}
                  />
                )}
                <ReviewRow
                  label="OS image"
                  value={AMI_OPTIONS.find((o) => o.value === answers.ami)?.label ?? answers.ami}
                />
                <ReviewRow
                  label="Key pair"
                  value={answers.sshKeyName.trim() || "(none — SSM only)"}
                />
                <ReviewRow label="VPC" value={answers.vpcId} />
                <ReviewRow
                  label="Subnet"
                  value={
                    pickedSubnet
                      ? `${pickedSubnet.subnetId} · ${pickedSubnet.cidr} · ${pickedSubnet.az} · ${pickedSubnet.isPublic ? "public" : "private"}`
                      : answers.subnetId
                  }
                />
                <ReviewRow
                  label="Firewall"
                  value={
                    [
                      answers.sshCidr.trim() ? `SSH from ${answers.sshCidr.trim()}` : "no SSH",
                      answers.allowHttp ? "HTTP open" : null,
                      answers.allowHttps ? "HTTPS open" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "no ingress (SSM only)"
                  }
                />
                <ReviewRow
                  label="Instance type"
                  value={
                    INSTANCE_TYPE_OPTIONS.find((o) => o.value === answers.instanceType)?.label ??
                    answers.instanceType
                  }
                />
                <ReviewRow
                  label="Root volume"
                  value={`${answers.diskGb} GiB · ${answers.volumeType}${hasIops && answers.volumeIops ? ` · ${answers.volumeIops} IOPS` : ""}${answers.encryptVolume ? " · encrypted" : " · unencrypted"}`}
                />
                {answers.userData.trim() && (
                  <ReviewRow
                    label="User data"
                    value={`${answers.userData.trim().split("\n").length} lines (runs on first boot)`}
                  />
                )}
              </div>
              {serverError && (
                <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
                  {serverError}
                </p>
              )}
            </div>
          )}

          {/* Nav */}
          <div className="row gap-2" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <Btn variant="ghost" onClick={back} disabled={pageIdx === 0 || submit.isPending}>
              Back
            </Btn>
            {onReview ? (
              <Btn variant="primary" icon="plus" loading={submit.isPending} onClick={handleLaunch}>
                Launch instance
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

// Narrower type so the submit call matches SubmitEc2Input.ami exactly.
type SubmitAmi =
  | "al2023"
  | "ubuntu-22.04"
  | "ubuntu-24.04"
  | "windows-2022"
  | "rhel-9"
  | "sles-15"
  | "debian-12";

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between" style={{ gap: 12, fontSize: 13 }}>
      <span className="muted">{label}</span>
      <span style={{ fontWeight: 600, textAlign: "right", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}
