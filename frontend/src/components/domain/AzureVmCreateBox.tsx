"use client";

/**
 * Azure VM launch wizard, embedded in chat via the ```azure-vm-create``` fence.
 * Console-style flow that matches Azure Portal's VM launcher — pick an
 * EXISTING VNet + subnet, image, size, admin creds, NSG toggles.
 */
import { useEffect, useMemo, useState } from "react";
import { Block, Btn, Field, Input, Select, type SelectOption } from "@/components/ui";
import { ApprovalCard } from "@/components/domain/ApprovalCard";
import { useProjectEnvs } from "@/hooks/queries/project";
import { useAzureVnetsInLocation, useSubmitAzureVm } from "@/hooks/queries/network";
import { AZURE_LOCATIONS } from "@/lib/azure-locations";

type AzureVmImage = "ubuntu-22.04" | "ubuntu-24.04" | "debian-12" | "rhel-9" | "windows-2022";
type Answers = {
  name: string;
  location: string;
  envKey: string;
  resourceGroupName: string;
  vnetName: string;
  subnetName: string;
  image: AzureVmImage;
  vmSize: string;
  diskGb: number;
  publicIp: boolean;
  adminUsername: string;
  sshPublicKey: string;
  adminPassword: string;
  allowSsh: boolean;
  allowRdp: boolean;
  allowHttp: boolean;
  allowHttps: boolean;
  sshCidr: string;
};

const PAGE_TITLES = ["Name & location", "VNet & subnet", "Image & login", "Size & firewall", "Review"];

const IMAGE_OPTIONS: SelectOption[] = [
  { value: "ubuntu-22.04", label: "Ubuntu 22.04 LTS" },
  { value: "ubuntu-24.04", label: "Ubuntu 24.04 LTS" },
  { value: "debian-12", label: "Debian 12" },
  { value: "rhel-9", label: "Red Hat Enterprise Linux 9" },
  { value: "windows-2022", label: "Windows Server 2022" },
];
const SIZE_OPTIONS: SelectOption[] = [
  { value: "Standard_B2s", label: "Standard_B2s — 2 vCPU / 4 GB (~$30/mo, burstable — dev/test)" },
  { value: "Standard_B2ms", label: "Standard_B2ms — 2 vCPU / 8 GB (~$60/mo)" },
  { value: "Standard_D2s_v5", label: "Standard_D2s_v5 — 2 vCPU / 8 GB (~$90/mo, general purpose)" },
  { value: "Standard_D4s_v5", label: "Standard_D4s_v5 — 4 vCPU / 16 GB (~$180/mo)" },
  { value: "Standard_E2s_v5", label: "Standard_E2s_v5 — 2 vCPU / 16 GB (~$120/mo, memory-optimized)" },
];

export function AzureVmCreateBox({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const submit = useSubmitAzureVm(slug);

  const [answers, setAnswers] = useState<Answers>({
    name: "app-vm",
    location: "eastus",
    envKey: "",
    resourceGroupName: "",
    vnetName: "",
    subnetName: "",
    image: "ubuntu-22.04",
    vmSize: "Standard_B2s",
    diskGb: 30,
    publicIp: true,
    adminUsername: "azureuser",
    sshPublicKey: "",
    adminPassword: "",
    allowSsh: true,
    allowRdp: false,
    allowHttp: false,
    allowHttps: false,
    sshCidr: "",
  });
  const [pageIdx, setPageIdx] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<{ approvalId: string; repoPath: string; repoFullName: string } | null>(null);

  const vnetsQuery = useAzureVnetsInLocation(slug, answers.location || null);

  useEffect(() => {
    if (answers.envKey || !envs?.length) return;
    setAnswers((a) => ({ ...a, envKey: envs[0]!.key }));
  }, [envs, answers.envKey]);

  // When VNet changes, backfill resourceGroupName + reset subnet.
  useEffect(() => {
    const vnets = vnetsQuery.data && "vnets" in vnetsQuery.data ? vnetsQuery.data.vnets : [];
    const picked = vnets.find((v) => v.name === answers.vnetName);
    if (picked && picked.resourceGroup !== answers.resourceGroupName) {
      setAnswers((a) => ({ ...a, resourceGroupName: picked.resourceGroup, subnetName: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers.vnetName, vnetsQuery.data]);

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({ value: e.key, label: e.name || e.key }));
  const locationOptions: SelectOption[] = useMemo(() => AZURE_LOCATIONS.map((l) => ({ value: l, label: l })), []);
  const vnets = vnetsQuery.data && "vnets" in vnetsQuery.data ? vnetsQuery.data.vnets : [];
  const vnetOptions: SelectOption[] = vnets.map((v) => ({ value: v.name, label: `${v.name} · ${v.resourceGroup} · ${v.addressSpace.join(", ")}` }));
  const pickedVnet = vnets.find((v) => v.name === answers.vnetName);
  const subnetOptions: SelectOption[] = (pickedVnet?.subnets ?? []).map((s) => ({ value: s.name, label: `${s.name} · ${s.addressPrefix}` }));

  const isWindows = answers.image === "windows-2022";

  const errors: Partial<Record<keyof Answers, string>> = {};
  if (pageIdx === 0) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(answers.name.trim())) errors.name = "Lowercase, dashes, 2-41 chars.";
    if (!answers.location) errors.location = "Pick a location.";
    if (!answers.envKey) errors.envKey = "Pick an env.";
  }
  if (pageIdx === 1) {
    if (!answers.vnetName) errors.vnetName = "Pick a VNet.";
    if (!answers.subnetName) errors.subnetName = "Pick a subnet.";
  }
  if (pageIdx === 2) {
    if (!answers.adminUsername.trim()) errors.adminUsername = "Required.";
    if (!isWindows && !answers.sshPublicKey.trim()) errors.sshPublicKey = "Paste your SSH public key (ssh-ed25519 …).";
    if (isWindows && answers.adminPassword.length < 12) errors.adminPassword = "Windows requires a 12+ char password with complexity.";
  }
  const pageHasError = Object.keys(errors).length > 0;
  const onReview = pageIdx === PAGE_TITLES.length - 1;

  async function handleCreate() {
    setServerError(null);
    try {
      const res = await submit.mutateAsync({
        name: answers.name.trim(),
        envKey: answers.envKey,
        location: answers.location,
        resourceGroupName: answers.resourceGroupName,
        vnetName: answers.vnetName,
        subnetName: answers.subnetName,
        image: answers.image,
        vmSize: answers.vmSize,
        diskGb: answers.diskGb,
        publicIp: answers.publicIp,
        adminUsername: answers.adminUsername.trim(),
        sshPublicKey: !isWindows ? answers.sshPublicKey.trim() : undefined,
        adminPassword: isWindows ? answers.adminPassword : undefined,
        allowSsh: answers.allowSsh,
        allowRdp: answers.allowRdp,
        allowHttp: answers.allowHttp,
        allowHttps: answers.allowHttps,
        sshCidr: answers.sshCidr.trim() || undefined,
      });
      if (res.approvalId) {
        setResult({
          approvalId: res.approvalId,
          repoPath: res.repoPath ?? "",
          repoFullName: res.repoFullName ?? "",
        });
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Azure VM submit failed.");
    }
  }

  if (result) {
    return (
      <Block>
        <Block.Header>
          <Block.Title sub={`Files committed to ${result.repoFullName}/${result.repoPath}. Approve to run terraform apply.`}>
            Azure VM submitted — pending approval
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
        <Block.Title sub="Console-style Azure VM launch. Attaches to an EXISTING VNet + subnet.">
          Launch Azure VM
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
              <Field label="Name" required error={errors.name}>
                <Input value={answers.name} onChange={(e) => setAnswers((a) => ({ ...a, name: e.target.value }))} className="mono" />
              </Field>
              <Field label="Location" required error={errors.location}>
                <Select options={locationOptions} value={answers.location} onValueChange={(v) => setAnswers((a) => ({ ...a, location: v, vnetName: "", subnetName: "", resourceGroupName: "" }))} ariaLabel="Location" />
              </Field>
              <Field label="Environment" required error={errors.envKey}>
                <Select options={envOptions} value={answers.envKey} onValueChange={(v) => setAnswers((a) => ({ ...a, envKey: v }))} ariaLabel="Env" placeholder="Pick an env…" />
              </Field>
            </div>
          )}

          {pageIdx === 1 && (
            <div className="col gap-3">
              <Field
                label="VNet"
                required
                error={errors.vnetName}
                hint={!answers.location ? "Pick a location first." : vnetsQuery.isLoading ? "Loading VNets…" : vnets.length === 0 ? `No VNets in ${answers.location}. Create one first (say 'create vnet').` : `${vnets.length} VNet${vnets.length === 1 ? "" : "s"} in ${answers.location}.`}
              >
                <Select options={vnetOptions} value={answers.vnetName} onValueChange={(v) => setAnswers((a) => ({ ...a, vnetName: v }))} ariaLabel="VNet" placeholder="Pick a VNet…" disabled={!answers.location || vnetOptions.length === 0} />
              </Field>
              <Field label="Subnet" required error={errors.subnetName} hint={!answers.vnetName ? "Pick a VNet first." : `${subnetOptions.length} subnet${subnetOptions.length === 1 ? "" : "s"} in ${answers.vnetName}.`}>
                <Select options={subnetOptions} value={answers.subnetName} onValueChange={(v) => setAnswers((a) => ({ ...a, subnetName: v }))} ariaLabel="Subnet" placeholder="Pick a subnet…" disabled={!answers.vnetName || subnetOptions.length === 0} />
              </Field>
              {answers.resourceGroupName && (
                <div className="muted" style={{ fontSize: 12 }}>Resource group: <span className="mono">{answers.resourceGroupName}</span></div>
              )}
            </div>
          )}

          {pageIdx === 2 && (
            <div className="col gap-3">
              <Field label="Image" required>
                <Select options={IMAGE_OPTIONS} value={answers.image} onValueChange={(v) => setAnswers((a) => ({ ...a, image: v as AzureVmImage }))} ariaLabel="Image" />
              </Field>
              <Field label="Admin username" required error={errors.adminUsername}>
                <Input value={answers.adminUsername} onChange={(e) => setAnswers((a) => ({ ...a, adminUsername: e.target.value }))} className="mono" />
              </Field>
              {isWindows ? (
                <Field label="Admin password" required error={errors.adminPassword} hint="12+ chars, mix of upper/lower/digit/symbol.">
                  <Input type="password" value={answers.adminPassword} onChange={(e) => setAnswers((a) => ({ ...a, adminPassword: e.target.value }))} className="mono" placeholder="•••••••••••" />
                </Field>
              ) : (
                <Field label="SSH public key" required error={errors.sshPublicKey} hint="Paste your ~/.ssh/id_ed25519.pub (starts with ssh-ed25519 or ssh-rsa).">
                  <Input value={answers.sshPublicKey} onChange={(e) => setAnswers((a) => ({ ...a, sshPublicKey: e.target.value }))} className="mono" placeholder="ssh-ed25519 AAAA…" />
                </Field>
              )}
            </div>
          )}

          {pageIdx === 3 && (
            <div className="col gap-3">
              <Field label="VM size" required>
                <Select options={SIZE_OPTIONS} value={answers.vmSize} onValueChange={(v) => setAnswers((a) => ({ ...a, vmSize: v }))} ariaLabel="VM size" />
              </Field>
              <Field label="OS disk (GB)" hint="Premium_LRS SSD. Default 30 (Linux) / 128 (Windows recommended).">
                <Input type="number" value={String(answers.diskGb)} onChange={(e) => setAnswers((a) => ({ ...a, diskGb: Number(e.target.value) || 30 }))} className="mono" />
              </Field>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={answers.publicIp} onChange={(e) => setAnswers((a) => ({ ...a, publicIp: e.target.checked }))} />
                <span>Attach a public IP (needed to reach the VM from the internet)</span>
              </label>
              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 4 }}>Firewall (NSG)</div>
              {!isWindows && (
                <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={answers.allowSsh} onChange={(e) => setAnswers((a) => ({ ...a, allowSsh: e.target.checked }))} />
                  <span>Allow SSH (TCP/22)</span>
                </label>
              )}
              {isWindows && (
                <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={answers.allowRdp} onChange={(e) => setAnswers((a) => ({ ...a, allowRdp: e.target.checked }))} />
                  <span>Allow RDP (TCP/3389)</span>
                </label>
              )}
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={answers.allowHttp} onChange={(e) => setAnswers((a) => ({ ...a, allowHttp: e.target.checked }))} />
                <span>Allow HTTP (TCP/80)</span>
              </label>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={answers.allowHttps} onChange={(e) => setAnswers((a) => ({ ...a, allowHttps: e.target.checked }))} />
                <span>Allow HTTPS (TCP/443)</span>
              </label>
              <Field label="Restrict SSH/RDP to CIDR" hint="Blank = 0.0.0.0/0 (open to internet). Prefer '<your-ip>/32'.">
                <Input value={answers.sshCidr} onChange={(e) => setAnswers((a) => ({ ...a, sshCidr: e.target.value }))} className="mono" placeholder="203.0.113.5/32" />
              </Field>
            </div>
          )}

          {onReview && (
            <div className="col gap-3">
              <div className="col gap-1" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
                <ReviewRow label="Name" value={answers.name} />
                <ReviewRow label="Location" value={answers.location} />
                <ReviewRow label="Environment" value={envs?.find((e) => e.key === answers.envKey)?.name ?? answers.envKey} />
                <ReviewRow label="Resource group" value={answers.resourceGroupName} />
                <ReviewRow label="VNet / subnet" value={`${answers.vnetName} / ${answers.subnetName}`} />
                <ReviewRow label="Image" value={answers.image} />
                <ReviewRow label="Size" value={answers.vmSize} />
                <ReviewRow label="Disk" value={`${answers.diskGb} GB Premium_LRS`} />
                <ReviewRow label="Public IP" value={answers.publicIp ? "yes" : "no"} />
                <ReviewRow label="Admin user" value={answers.adminUsername} />
              </div>
              {serverError && <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">{serverError}</p>}
            </div>
          )}

          <div className="row gap-2" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <Btn variant="ghost" onClick={() => setPageIdx((i) => Math.max(0, i - 1))} disabled={pageIdx === 0 || submit.isPending}>Back</Btn>
            {onReview ? (
              <Btn variant="primary" icon="plus" loading={submit.isPending} onClick={handleCreate}>Launch VM</Btn>
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
