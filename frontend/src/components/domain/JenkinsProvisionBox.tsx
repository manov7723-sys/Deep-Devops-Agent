"use client";

/**
 * One-click Jenkins provisioning wizard, embedded in chat via the
 * ```jenkins-provision``` fence. User picks a VPC + public subnet + admin
 * creds, submits, approves → EC2 boots with Jenkins pre-installed and the
 * admin user auto-created (no setup wizard, no manual plugin installs at
 * first login).
 */
import { useEffect, useMemo, useState } from "react";
import { Block, Btn, Field, Input, Select, type SelectOption } from "@/components/ui";
import { ApprovalCard } from "@/components/domain/ApprovalCard";
import { useProjectEnvs } from "@/hooks/queries/project";
import {
  useAwsVpcsInRegion,
  useAwsSubnetsInVpc,
  useAwsKeyPairsInRegion,
  useAwsSecurityGroupsInVpc,
  useSubmitJenkinsProvision,
} from "@/hooks/queries/network";
import { AWS_REGIONS } from "@/lib/aws-regions";

type Answers = {
  name: string;
  region: string;
  envKey: string;
  vpcId: string;
  subnetId: string;
  instanceType: string;
  diskGb: number;
  adminUsername: string;
  adminPassword: string;
  keyName: string;
  sshCidr: string;
  jenkinsCidr: string;
  useExistingSgs: boolean;
  existingSecurityGroupIds: string[];
};

const PAGE_TITLES = ["Name & region", "VPC & subnet", "Size & credentials", "Review"];

const INSTANCE_OPTIONS: SelectOption[] = [
  { value: "t3.micro", label: "t3.micro — 2 vCPU / 1 GB (~$8/mo, tight for Jenkins)" },
  { value: "t3.small", label: "t3.small — 2 vCPU / 2 GB (~$15/mo, recommended)" },
  { value: "t3.medium", label: "t3.medium — 2 vCPU / 4 GB (~$30/mo, comfy)" },
  { value: "t3.large", label: "t3.large — 2 vCPU / 8 GB (~$60/mo, plenty of headroom)" },
  { value: "m5.large", label: "m5.large — 2 vCPU / 8 GB (~$70/mo, stable perf)" },
];

// Generate an easy-to-remember but decent starter password. User can accept
// or override on the credentials page. 16 chars mixed case + digits.
function suggestPassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const buf = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => chars[b % chars.length]).join("");
}

export function JenkinsProvisionBox({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const submit = useSubmitJenkinsProvision(slug);

  const [answers, setAnswers] = useState<Answers>({
    name: "jenkins",
    region: "us-east-1",
    envKey: "",
    vpcId: "",
    subnetId: "",
    instanceType: "t3.small",
    diskGb: 30,
    adminUsername: "admin",
    adminPassword: suggestPassword(),
    // SSH: pick an EXISTING AWS EC2 key pair (matches EC2 wizard's UX).
    // The dropdown on page 3 lists key pairs in the picked region — user
    // selects the one they already have the .pem for on their laptop.
    keyName: "",
    sshCidr: "",
    jenkinsCidr: "0.0.0.0/0",
    // SG default: create a fresh one (matches EC2 wizard behavior). Toggle
    // to "Attach existing" if the team manages SGs externally.
    useExistingSgs: false,
    existingSecurityGroupIds: [],
  });
  const [pageIdx, setPageIdx] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [detectingIp, setDetectingIp] = useState(false);
  // Only auto-fill the SSH CIDR once per wizard session — otherwise picking
  // and re-picking a key pair would keep re-detecting and stomping user edits.
  const [autoFilledSshFromKey, setAutoFilledSshFromKey] = useState(false);

  // Hit checkip.amazonaws.com to grab the caller's public IP and drop it into
  // the SSH CIDR field. Saves the user from `curl checkip` + typing `/32`,
  // which is the friction that leaves people with port 22 closed by accident.
  async function useMyIp() {
    setDetectingIp(true);
    try {
      const res = await fetch("https://checkip.amazonaws.com", { cache: "no-store" });
      const ip = (await res.text()).trim();
      // Basic IPv4 shape check — checkip returns plain "1.2.3.4\n"
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
        setAnswers((a) => ({ ...a, sshCidr: `${ip}/32` }));
      } else {
        setAnswers((a) => ({ ...a, sshCidr: "" }));
      }
    } catch {
      // Silent — user can still type manually.
    } finally {
      setDetectingIp(false);
    }
  }

  // When the user picks an EC2 key pair, auto-fill the SSH CIDR with their
  // public IP — otherwise they'd pick a key, forget to open port 22, and
  // hit "Operation timed out" when they try to SSH in. Only fires once per
  // session and only when the CIDR is currently blank + we're in the
  // create-new-SG path (existing-SG path uses caller-owned SGs).
  useEffect(() => {
    if (autoFilledSshFromKey) return;
    if (!answers.keyName.trim()) return;
    if (answers.useExistingSgs) return;
    if (answers.sshCidr.trim()) return;
    setAutoFilledSshFromKey(true);
    void useMyIp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers.keyName, answers.useExistingSgs]);
  const [result, setResult] = useState<
    | null
    | { approvalId: string; repoPath: string; repoFullName: string; jenkinsfileCreated: boolean }
  >(null);

  const vpcsQuery = useAwsVpcsInRegion(slug, answers.region || null);
  const subnetsQuery = useAwsSubnetsInVpc(slug, answers.region || null, answers.vpcId || null);
  const keyPairsQuery = useAwsKeyPairsInRegion(slug, answers.region || null);
  // Only fire the SG list once the user opts into "existing SGs" — no point
  // paying the AWS describe call for the default create-new path.
  const sgsQuery = useAwsSecurityGroupsInVpc(
    slug,
    answers.useExistingSgs && answers.region ? answers.region : null,
    answers.useExistingSgs && answers.vpcId ? answers.vpcId : null,
  );

  useEffect(() => {
    if (answers.envKey || !envs?.length) return;
    setAnswers((a) => ({ ...a, envKey: envs[0]!.key }));
  }, [envs, answers.envKey]);

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({ value: e.key, label: e.name || e.key }));
  const regionOptions: SelectOption[] = useMemo(() => AWS_REGIONS.map((r) => ({ value: r, label: r })), []);
  const vpcs = vpcsQuery.data && "vpcs" in vpcsQuery.data ? vpcsQuery.data.vpcs : [];
  const vpcOptions: SelectOption[] = vpcs.map((v) => ({
    value: v.vpcId,
    label: `${v.vpcId} · ${v.cidr}${v.name ? ` · ${v.name}` : ""}`,
  }));
  const subnets = subnetsQuery.data?.ok ? subnetsQuery.data.subnets ?? [] : [];
  // Show ALL subnets — the `isPublic` flag from AWS is derived from
  // MapPublicIpOnLaunch, which is often false on genuinely public subnets
  // too. We can't reliably infer "public vs private" without querying route
  // tables. Label public ones so the user can prefer them, but let them
  // pick anything — terraform apply will error out clearly if the picked
  // subnet has no route to an IGW.
  const subnetOptions: SelectOption[] = subnets.map((s) => ({
    value: s.subnetId,
    label:
      `${s.subnetId} · ${s.cidr} · ${s.az}` +
      (s.name ? ` · ${s.name}` : "") +
      (s.isPublic ? " · public" : ""),
  }));
  const keyPairs = keyPairsQuery.data && "keyPairs" in keyPairsQuery.data ? keyPairsQuery.data.keyPairs : [];
  const keyPairOptions: SelectOption[] = keyPairs.map((k) => ({
    value: k.name,
    label: `${k.name} · ${k.type}`,
  }));
  const sgs = sgsQuery.data && "securityGroups" in sgsQuery.data ? sgsQuery.data.securityGroups : [];

  const errors: Partial<Record<keyof Answers, string>> = {};
  if (pageIdx === 0) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(answers.name.trim())) errors.name = "Lowercase, dashes, 2-41 chars.";
    if (!answers.region) errors.region = "Pick a region.";
    if (!answers.envKey) errors.envKey = "Pick an env.";
  }
  if (pageIdx === 1) {
    if (!answers.vpcId) errors.vpcId = "Pick a VPC.";
    if (!answers.subnetId) errors.subnetId = "Pick a public subnet.";
  }
  if (pageIdx === 2) {
    if (!answers.adminUsername.trim()) errors.adminUsername = "Required.";
    if (answers.adminPassword.length < 8) errors.adminPassword = "At least 8 characters.";
    if (answers.sshCidr.trim()) {
      // Very rough CIDR shape — server + terraform do the strict check.
      if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(answers.sshCidr.trim())) {
        errors.sshCidr = "Not a valid CIDR (e.g. 203.0.113.5/32).";
      } else if (answers.sshCidr.trim() === "0.0.0.0/0") {
        errors.sshCidr = "Policy blocks 0.0.0.0/0 on SSH — use a narrow CIDR like <your-ip>/32.";
      }
    }
    if (answers.useExistingSgs && answers.existingSecurityGroupIds.length === 0) {
      // Blocking so the user can't accidentally submit with "existing" mode
      // but zero SGs picked — that would attach no SGs to the instance.
      errors.existingSecurityGroupIds = "Pick at least one security group (or turn off 'Attach existing').";
    }
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
        vpcId: answers.vpcId,
        subnetId: answers.subnetId,
        instanceType: answers.instanceType,
        diskGb: answers.diskGb,
        adminUsername: answers.adminUsername.trim(),
        adminPassword: answers.adminPassword,
        // Strip a trailing ".pem" if the user typed the filename — AWS key
        // pair NAMES never include the .pem extension (that's only the local
        // private-key filename convention). Silent to avoid friction.
        keyName: answers.keyName.trim().replace(/\.pem$/i, "") || undefined,
        // When "attach existing SGs" is on, sshCidr/jenkinsCidr are ignored
        // by the server (no auto-created SG) — send undefined for clarity.
        sshCidr: answers.useExistingSgs ? undefined : (answers.sshCidr.trim() || undefined),
        jenkinsCidr: answers.useExistingSgs ? undefined : (answers.jenkinsCidr.trim() || undefined),
        existingSecurityGroupIds: answers.useExistingSgs ? answers.existingSecurityGroupIds : undefined,
      });
      if (res.approvalId) {
        setResult({
          approvalId: res.approvalId,
          repoPath: res.repoPath ?? "",
          repoFullName: res.repoFullName ?? "",
          jenkinsfileCreated: !!res.jenkinsfileCreated,
        });
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Jenkins provision submit failed.");
    }
  }

  if (result) {
    return (
      <Block>
        <Block.Header>
          <Block.Title sub={`Files committed to ${result.repoFullName}/${result.repoPath}. Approve below to run terraform apply — Jenkins boots in ~5 min.`}>
            Jenkins submitted — pending approval
          </Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="col gap-3">
            <ApprovalCard slug={slug} approvalId={result.approvalId} />
            {result.jenkinsfileCreated && (
              <div className="muted" style={{ fontSize: 12.5 }}>
                A starter <span className="mono">Jenkinsfile.deepagent-starter</span> was committed to the repo root.
                Rename it to <span className="mono">Jenkinsfile</span> once Jenkins is up if you want it to run out of the box.
              </div>
            )}
          </div>
        </Block.Body>
      </Block>
    );
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="One-click Jenkins on EC2. Admin user auto-created; skip the setup wizard. Ready in ~5 min.">
          Provision Jenkins
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-4" style={{ maxWidth: 680 }}>
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
              <Field label="Name" required hint="Lowercase, dashes. Tags every resource." error={errors.name}>
                <Input value={answers.name} onChange={(e) => setAnswers((a) => ({ ...a, name: e.target.value }))} className="mono" />
              </Field>
              <Field label="Region" required error={errors.region}>
                <Select options={regionOptions} value={answers.region} onValueChange={(v) => setAnswers((a) => ({ ...a, region: v, vpcId: "", subnetId: "" }))} ariaLabel="Region" />
              </Field>
              <Field label="Environment" required error={errors.envKey}>
                <Select options={envOptions} value={answers.envKey} onValueChange={(v) => setAnswers((a) => ({ ...a, envKey: v }))} ariaLabel="Environment" placeholder="Pick an env…" />
              </Field>
            </div>
          )}

          {pageIdx === 1 && (
            <div className="col gap-3">
              <Field
                label="VPC"
                required
                error={errors.vpcId}
                hint={!answers.region ? "Pick a region first." : vpcsQuery.isLoading ? "Loading VPCs…" : vpcs.length === 0 ? "No VPCs in this region. Create one first." : `${vpcs.length} VPC${vpcs.length === 1 ? "" : "s"} in ${answers.region}.`}
              >
                <Select options={vpcOptions} value={answers.vpcId} onValueChange={(v) => setAnswers((a) => ({ ...a, vpcId: v, subnetId: "" }))} ariaLabel="VPC" placeholder="Pick a VPC…" disabled={!answers.region || vpcOptions.length === 0} />
              </Field>
              <Field
                label="Subnet"
                required
                error={errors.subnetId}
                hint={
                  !answers.vpcId
                    ? "Pick a VPC first."
                    : subnetsQuery.isLoading
                      ? "Loading subnets…"
                      : subnetOptions.length === 0
                        ? "No subnets in this VPC."
                        : `${subnetOptions.length} subnet${subnetOptions.length === 1 ? "" : "s"}. Prefer one labelled 'public' — Jenkins needs a route to the internet gateway.`
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
            </div>
          )}

          {pageIdx === 2 && (
            <div className="col gap-3">
              <Field label="Instance type" required hint="t3.small handles solo/team use fine. Bump to t3.medium if you plan to run heavy builds on the master.">
                <Select options={INSTANCE_OPTIONS} value={answers.instanceType} onValueChange={(v) => setAnswers((a) => ({ ...a, instanceType: v }))} ariaLabel="Instance type" />
              </Field>
              <Field label="Root disk (GB)" hint="Default 30 GB. Bump if you plan lots of workspaces / artifacts.">
                <Input type="number" value={String(answers.diskGb)} onChange={(e) => setAnswers((a) => ({ ...a, diskGb: Number(e.target.value) || 30 }))} className="mono" />
              </Field>
              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 4 }}>Admin credentials</div>
              <Field label="Admin username" required error={errors.adminUsername}>
                <Input value={answers.adminUsername} onChange={(e) => setAnswers((a) => ({ ...a, adminUsername: e.target.value }))} className="mono" />
              </Field>
              <Field
                label="Admin password"
                required
                error={errors.adminPassword}
                hint="Pre-filled with a random suggestion — feel free to change. You'll need this to log in at the URL after apply."
              >
                <div className="row gap-2">
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={answers.adminPassword}
                    onChange={(e) => setAnswers((a) => ({ ...a, adminPassword: e.target.value }))}
                    className="mono"
                    style={{ flex: 1 }}
                  />
                  <Btn variant="ghost" onClick={() => setShowPassword((s) => !s)}>
                    {showPassword ? "Hide" : "Show"}
                  </Btn>
                  <Btn variant="ghost" onClick={() => setAnswers((a) => ({ ...a, adminPassword: suggestPassword() }))}>
                    Regenerate
                  </Btn>
                </div>
              </Field>
              <div
                className="row gap-2"
                style={{ padding: 10, borderRadius: 8, background: "var(--warn-soft)", color: "var(--warn)", fontSize: 12.5 }}
                role="alert"
              >
                <span>
                  This password is passed via EC2 user-data, visible to anyone with
                  <span className="mono"> ec2:DescribeInstances</span> on your AWS account. Rotate it from Manage Jenkins → Users at first login.
                </span>
              </div>

              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 8 }}>Security groups</div>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={answers.useExistingSgs}
                  onChange={(e) =>
                    setAnswers((a) => ({
                      ...a,
                      useExistingSgs: e.target.checked,
                      // Reset picks when flipping so stale ids don't carry over.
                      existingSecurityGroupIds: e.target.checked ? a.existingSecurityGroupIds : [],
                    }))
                  }
                />
                <span>
                  Attach existing security groups (your SGs must already allow
                  <span className="mono"> TCP/8080</span> from wherever you'll use the UI, and
                  <span className="mono"> TCP/22</span> if you plan to SSH)
                </span>
              </label>
              {!answers.useExistingSgs && (
                <div className="muted" style={{ fontSize: 12 }}>
                  Default: create a fresh SG that opens <span className="mono">8080</span> to the internet
                  (Jenkins UI) plus <span className="mono">22</span> to whatever CIDR you fill below.
                </div>
              )}
              {answers.useExistingSgs && (
                <>
                  <Field
                    label="Pick SGs to attach (max 5)"
                    error={errors.existingSecurityGroupIds}
                    hint={
                      !answers.vpcId
                        ? "Pick a VPC on page 2 first."
                        : sgsQuery.isLoading
                          ? "Loading security groups…"
                          : sgs.length === 0
                            ? "No SGs in this VPC."
                            : `${sgs.length} SG${sgs.length === 1 ? "" : "s"} in this VPC. Check the ones you want attached.`
                    }
                  >
                    <div
                      className="col gap-1"
                      style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}
                    >
                      {sgs.length === 0 && !sgsQuery.isLoading && (
                        <div className="muted" style={{ fontSize: 12.5, padding: 8 }}>
                          {sgsQuery.data && !("connected" in sgsQuery.data && sgsQuery.data.connected)
                            ? (sgsQuery.data as { note?: string }).note ?? "No SGs available."
                            : "No SGs in this VPC."}
                        </div>
                      )}
                      {sgs.map((sg) => {
                        const checked = answers.existingSecurityGroupIds.includes(sg.groupId);
                        return (
                          <label
                            key={sg.groupId}
                            className="row gap-2"
                            style={{ fontSize: 13, cursor: "pointer", padding: 4 }}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setAnswers((a) => {
                                  const has = a.existingSecurityGroupIds.includes(sg.groupId);
                                  const next = has
                                    ? a.existingSecurityGroupIds.filter((x) => x !== sg.groupId)
                                    : [...a.existingSecurityGroupIds, sg.groupId];
                                  // Enforce the max of 5 the server also checks.
                                  return { ...a, existingSecurityGroupIds: next.slice(0, 5) };
                                })
                              }
                              disabled={!checked && answers.existingSecurityGroupIds.length >= 5}
                            />
                            <span className="mono">{sg.groupId}</span>
                            <span className="muted">
                              · {sg.groupName || "(unnamed)"} · {sg.inboundRuleCount} inbound rule{sg.inboundRuleCount === 1 ? "" : "s"}
                              {sg.description ? ` · ${sg.description.slice(0, 60)}` : ""}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </Field>
                </>
              )}

              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 8 }}>SSH access (optional)</div>
              <Field
                label="EC2 key pair name"
                hint={
                  keyPairs.length > 0
                    ? `Type the key pair NAME only, no .pem extension. Available in ${answers.region}: ${keyPairs.map((k) => k.name).join(", ")}. Leave blank = no SSH key (SSM only).`
                    : "Type the key pair NAME only, no .pem extension. Case-sensitive, must exist in the picked region. Leave blank = SSM only."
                }
              >
                <Input
                  value={answers.keyName}
                  onChange={(e) => setAnswers((a) => ({ ...a, keyName: e.target.value }))}
                  className="mono"
                  placeholder="e.g. hari (NOT hari.pem)"
                />
              </Field>
              {answers.useExistingSgs ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  &ldquo;Allow SSH from CIDR&rdquo; is disabled because you&apos;re attaching existing SGs — your SGs already own the ingress rules.
                </div>
              ) : null}
              <Field
                label="Allow SSH from CIDR"
                error={errors.sshCidr}
                hint={
                  answers.useExistingSgs
                    ? "Ignored when attaching existing SGs."
                    : "Type your IP as a CIDR (e.g. 203.0.113.5/32) to open port 22 — or click 'Use my IP' below to auto-detect it. Leave blank to keep SSH closed. Policy blocks 0.0.0.0/0."
                }
              >
                <div className="row gap-2">
                  <Input
                    value={answers.sshCidr}
                    onChange={(e) => setAnswers((a) => ({ ...a, sshCidr: e.target.value }))}
                    className="mono"
                    placeholder="203.0.113.5/32 or click 'Use my IP'"
                    style={{ flex: 1 }}
                    disabled={answers.useExistingSgs}
                  />
                  <Btn
                    variant="ghost"
                    onClick={useMyIp}
                    loading={detectingIp}
                    disabled={detectingIp || answers.useExistingSgs}
                  >
                    Use my IP
                  </Btn>
                  {answers.sshCidr.trim() && !answers.useExistingSgs && (
                    <Btn
                      variant="ghost"
                      onClick={() => setAnswers((a) => ({ ...a, sshCidr: "" }))}
                    >
                      Clear
                    </Btn>
                  )}
                </div>
              </Field>
              {answers.keyName && !answers.sshCidr.trim() && (
                <div
                  className="row gap-2"
                  style={{ padding: 10, borderRadius: 8, background: "var(--warn-soft)", color: "var(--warn)", fontSize: 12.5 }}
                  role="alert"
                >
                  <span>
                    You picked SSH key <span className="mono">{answers.keyName}</span> but SSH is still closed. SSH will fail with &quot;Operation timed out&quot;
                    until you open port 22. Click <b>Use my IP</b> above to fix.
                  </span>
                </div>
              )}
            </div>
          )}

          {onReview && (
            <div className="col gap-3">
              <div className="col gap-1" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
                <ReviewRow label="Name" value={answers.name} />
                <ReviewRow label="Region" value={answers.region} />
                <ReviewRow label="Environment" value={envs?.find((e) => e.key === answers.envKey)?.name ?? answers.envKey} />
                <ReviewRow label="VPC / subnet" value={`${answers.vpcId} / ${answers.subnetId}`} />
                <ReviewRow label="Instance" value={answers.instanceType} />
                <ReviewRow label="Disk" value={`${answers.diskGb} GB gp3`} />
                <ReviewRow label="Admin user" value={answers.adminUsername} />
                <ReviewRow label="Admin password" value={showPassword ? answers.adminPassword : "••••••••"} />
                {answers.useExistingSgs ? (
                  <ReviewRow
                    label="Security groups"
                    value={`attach existing: ${answers.existingSecurityGroupIds.join(", ") || "(none picked)"}`}
                  />
                ) : (
                  <>
                    <ReviewRow label="UI open to" value={answers.jenkinsCidr} />
                    <ReviewRow label="SSH port 22" value={answers.sshCidr.trim() ? `open to ${answers.sshCidr.trim()}` : "closed (use aws ssm start-session)"} />
                  </>
                )}
                <ReviewRow label="SSH key pair" value={answers.keyName.trim() || "none (SSM only)"} />
              </div>
              {serverError && <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">{serverError}</p>}
            </div>
          )}

          <div className="row gap-2" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <Btn variant="ghost" onClick={() => setPageIdx((i) => Math.max(0, i - 1))} disabled={pageIdx === 0 || submit.isPending}>Back</Btn>
            {onReview ? (
              <Btn variant="primary" icon="rocket" loading={submit.isPending} onClick={handleCreate}>Provision Jenkins</Btn>
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
