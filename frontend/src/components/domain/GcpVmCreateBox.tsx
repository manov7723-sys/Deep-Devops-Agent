"use client";

/**
 * GCP Compute Engine VM launch wizard, embedded in chat via the
 * ```gcp-vm-create``` fence. Console-style launcher that picks an EXISTING
 * VPC network + subnet in the target region + zone.
 */
import { useEffect, useMemo, useState } from "react";
import { Block, Btn, Field, Input, Select, type SelectOption } from "@/components/ui";
import { ApprovalCard } from "@/components/domain/ApprovalCard";
import { useProjectEnvs } from "@/hooks/queries/project";
import { useGcpContext, useGcpNetworksInRegion, useSubmitGcpVm } from "@/hooks/queries/network";
import { GCP_REGIONS } from "@/lib/gcp-regions";

type GcpVmImage = "debian-12" | "ubuntu-2204-lts" | "ubuntu-2404-lts" | "rocky-linux-9" | "windows-2022";
type Answers = {
  name: string;
  region: string;
  zone: string;
  envKey: string;
  networkName: string;
  subnetName: string;
  image: GcpVmImage;
  machineType: string;
  diskGb: number;
  diskType: "pd-standard" | "pd-balanced" | "pd-ssd";
  publicIp: boolean;
  sshUsername: string;
  sshPublicKey: string;
  windowsAdminUsername: string;
  windowsAdminPassword: string;
  allowIapSsh: boolean;
  allowHttp: boolean;
  allowHttps: boolean;
};

const PAGE_TITLES = ["Name & zone", "Network", "Image & login", "Size & firewall", "Review"];

const IMAGE_OPTIONS: SelectOption[] = [
  { value: "debian-12", label: "Debian 12" },
  { value: "ubuntu-2204-lts", label: "Ubuntu 22.04 LTS" },
  { value: "ubuntu-2404-lts", label: "Ubuntu 24.04 LTS" },
  { value: "rocky-linux-9", label: "Rocky Linux 9" },
  { value: "windows-2022", label: "Windows Server 2022" },
];
const MACHINE_OPTIONS: SelectOption[] = [
  { value: "e2-micro", label: "e2-micro — 2 vCPU / 1 GB (free-tier eligible, ~$7/mo)" },
  { value: "e2-small", label: "e2-small — 2 vCPU / 2 GB (~$14/mo)" },
  { value: "e2-medium", label: "e2-medium — 2 vCPU / 4 GB (~$25/mo, general purpose default)" },
  { value: "n2-standard-2", label: "n2-standard-2 — 2 vCPU / 8 GB (~$70/mo, faster)" },
  { value: "n2-standard-4", label: "n2-standard-4 — 4 vCPU / 16 GB (~$140/mo)" },
];
const DISK_TYPE_OPTIONS: SelectOption[] = [
  { value: "pd-standard", label: "pd-standard (HDD — cheapest, slower IOPS)" },
  { value: "pd-balanced", label: "pd-balanced (SSD — default, good price/perf)" },
  { value: "pd-ssd", label: "pd-ssd (SSD — fastest, most expensive)" },
];

// GCP zones per region — hardcoded rather than API-listed to keep the wizard
// snappy. Only a few zones are commonly used per region.
const ZONES_BY_REGION: Record<string, string[]> = {
  "us-central1": ["us-central1-a", "us-central1-b", "us-central1-c", "us-central1-f"],
  "us-east1": ["us-east1-b", "us-east1-c", "us-east1-d"],
  "us-east4": ["us-east4-a", "us-east4-b", "us-east4-c"],
  "us-west1": ["us-west1-a", "us-west1-b", "us-west1-c"],
  "us-west2": ["us-west2-a", "us-west2-b", "us-west2-c"],
  "us-west3": ["us-west3-a", "us-west3-b", "us-west3-c"],
  "us-west4": ["us-west4-a", "us-west4-b", "us-west4-c"],
  "europe-west1": ["europe-west1-b", "europe-west1-c", "europe-west1-d"],
  "europe-west2": ["europe-west2-a", "europe-west2-b", "europe-west2-c"],
  "europe-west3": ["europe-west3-a", "europe-west3-b", "europe-west3-c"],
  "europe-west4": ["europe-west4-a", "europe-west4-b", "europe-west4-c"],
  "asia-east1": ["asia-east1-a", "asia-east1-b", "asia-east1-c"],
  "asia-northeast1": ["asia-northeast1-a", "asia-northeast1-b", "asia-northeast1-c"],
  "asia-south1": ["asia-south1-a", "asia-south1-b", "asia-south1-c"],
  "asia-southeast1": ["asia-southeast1-a", "asia-southeast1-b", "asia-southeast1-c"],
  "australia-southeast1": ["australia-southeast1-a", "australia-southeast1-b", "australia-southeast1-c"],
};

function zonesForRegion(region: string): string[] {
  return ZONES_BY_REGION[region] ?? [`${region}-a`, `${region}-b`, `${region}-c`];
}

export function GcpVmCreateBox({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const gcpCtx = useGcpContext(slug);
  const submit = useSubmitGcpVm(slug);

  const [answers, setAnswers] = useState<Answers>({
    name: "app-vm",
    region: "us-central1",
    zone: "us-central1-a",
    envKey: "",
    networkName: "",
    subnetName: "",
    image: "ubuntu-2204-lts",
    machineType: "e2-medium",
    diskGb: 20,
    diskType: "pd-balanced",
    publicIp: true,
    sshUsername: "ubuntu",
    sshPublicKey: "",
    windowsAdminUsername: "cloudadmin",
    windowsAdminPassword: "",
    allowIapSsh: true,
    allowHttp: false,
    allowHttps: false,
  });
  const [pageIdx, setPageIdx] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<{ approvalId: string; repoPath: string; repoFullName: string } | null>(null);

  const gcpProjectId = gcpCtx.data?.activeProjectId ?? null;
  const netsQuery = useGcpNetworksInRegion(slug, gcpProjectId, answers.region || null);

  useEffect(() => {
    if (answers.envKey || !envs?.length) return;
    setAnswers((a) => ({ ...a, envKey: envs[0]!.key }));
  }, [envs, answers.envKey]);

  // Keep zone in the picked region.
  useEffect(() => {
    if (!answers.zone.startsWith(answers.region)) {
      setAnswers((a) => ({ ...a, zone: zonesForRegion(a.region)[0]! }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers.region]);

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({ value: e.key, label: e.name || e.key }));
  const regionOptions: SelectOption[] = useMemo(() => GCP_REGIONS.map((r) => ({ value: r, label: r })), []);
  const zoneOptions: SelectOption[] = zonesForRegion(answers.region).map((z) => ({ value: z, label: z }));

  const networks = netsQuery.data?.networks ?? [];
  const subnetworks = netsQuery.data?.subnetworks ?? [];
  const pickedNet = networks.find((n) => n.name === answers.networkName);
  const subnetsForNet = pickedNet ? subnetworks.filter((s) => s.network === pickedNet.selfLink) : [];
  const networkOptions: SelectOption[] = networks.map((n) => ({ value: n.name, label: n.name }));
  const subnetOptions: SelectOption[] = subnetsForNet.map((s) => ({ value: s.name, label: `${s.name} · ${s.ipCidrRange}` }));

  const isWindows = answers.image === "windows-2022";

  const errors: Partial<Record<keyof Answers, string>> = {};
  if (pageIdx === 0) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(answers.name.trim())) errors.name = "Lowercase, dashes, 2-41 chars.";
    if (!answers.region) errors.region = "Pick a region.";
    if (!answers.zone) errors.zone = "Pick a zone.";
    if (!answers.envKey) errors.envKey = "Pick an env.";
  }
  if (pageIdx === 1) {
    if (!answers.networkName) errors.networkName = "Pick a network.";
    if (!answers.subnetName) errors.subnetName = "Pick a subnet.";
  }
  if (pageIdx === 2) {
    if (!isWindows && !answers.sshPublicKey.trim()) errors.sshPublicKey = "Paste your SSH public key.";
    if (isWindows && answers.windowsAdminPassword.length < 12) errors.windowsAdminPassword = "Windows requires a 12+ char password.";
  }
  const pageHasError = Object.keys(errors).length > 0;
  const onReview = pageIdx === PAGE_TITLES.length - 1;

  async function handleCreate() {
    setServerError(null);
    try {
      const res = await submit.mutateAsync({
        name: answers.name.trim(),
        envKey: answers.envKey,
        zone: answers.zone,
        region: answers.region,
        networkName: answers.networkName,
        subnetName: answers.subnetName,
        image: answers.image,
        machineType: answers.machineType,
        diskGb: answers.diskGb,
        diskType: answers.diskType,
        publicIp: answers.publicIp,
        sshUsername: !isWindows ? answers.sshUsername.trim() : undefined,
        sshPublicKey: !isWindows ? answers.sshPublicKey.trim() : undefined,
        windowsAdminUsername: isWindows ? answers.windowsAdminUsername.trim() : undefined,
        windowsAdminPassword: isWindows ? answers.windowsAdminPassword : undefined,
        allowIapSsh: answers.allowIapSsh,
        allowHttp: answers.allowHttp,
        allowHttps: answers.allowHttps,
      });
      if (res.approvalId) {
        setResult({ approvalId: res.approvalId, repoPath: res.repoPath ?? "", repoFullName: res.repoFullName ?? "" });
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "GCP VM submit failed.");
    }
  }

  if (result) {
    return (
      <Block>
        <Block.Header>
          <Block.Title sub={`Files committed to ${result.repoFullName}/${result.repoPath}. Approve to run terraform apply.`}>
            GCP VM submitted — pending approval
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
        <Block.Title sub="Console-style GCP VM launch. Attaches to an EXISTING network + subnet in the picked region.">
          Launch GCP VM
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
              <Field label="Region" required error={errors.region}>
                <Select options={regionOptions} value={answers.region} onValueChange={(v) => setAnswers((a) => ({ ...a, region: v, networkName: "", subnetName: "" }))} ariaLabel="Region" />
              </Field>
              <Field label="Zone" required error={errors.zone} hint="GCP VMs are zonal. Pick one zone in the region.">
                <Select options={zoneOptions} value={answers.zone} onValueChange={(v) => setAnswers((a) => ({ ...a, zone: v }))} ariaLabel="Zone" />
              </Field>
              <Field label="Environment" required error={errors.envKey}>
                <Select options={envOptions} value={answers.envKey} onValueChange={(v) => setAnswers((a) => ({ ...a, envKey: v }))} ariaLabel="Env" placeholder="Pick an env…" />
              </Field>
              {gcpProjectId && (
                <div className="muted" style={{ fontSize: 12 }}>Active GCP project: <span className="mono">{gcpProjectId}</span></div>
              )}
            </div>
          )}

          {pageIdx === 1 && (
            <div className="col gap-3">
              <Field
                label="Network"
                required
                error={errors.networkName}
                hint={!gcpProjectId ? "No active GCP project — set one on the Cloud providers page." : netsQuery.isLoading ? "Loading networks…" : networks.length === 0 ? `No networks in ${answers.region}. Create one first (say 'create gcp vpc').` : `${networks.length} network${networks.length === 1 ? "" : "s"} in ${answers.region}.`}
              >
                <Select options={networkOptions} value={answers.networkName} onValueChange={(v) => setAnswers((a) => ({ ...a, networkName: v, subnetName: "" }))} ariaLabel="Network" placeholder="Pick a network…" disabled={networkOptions.length === 0} />
              </Field>
              <Field label="Subnet" required error={errors.subnetName} hint={!answers.networkName ? "Pick a network first." : `${subnetOptions.length} subnet${subnetOptions.length === 1 ? "" : "s"} in this network + region.`}>
                <Select options={subnetOptions} value={answers.subnetName} onValueChange={(v) => setAnswers((a) => ({ ...a, subnetName: v }))} ariaLabel="Subnet" placeholder="Pick a subnet…" disabled={!answers.networkName || subnetOptions.length === 0} />
              </Field>
            </div>
          )}

          {pageIdx === 2 && (
            <div className="col gap-3">
              <Field label="Image" required>
                <Select options={IMAGE_OPTIONS} value={answers.image} onValueChange={(v) => setAnswers((a) => ({ ...a, image: v as GcpVmImage }))} ariaLabel="Image" />
              </Field>
              {isWindows ? (
                <>
                  <Field label="Admin username" required>
                    <Input value={answers.windowsAdminUsername} onChange={(e) => setAnswers((a) => ({ ...a, windowsAdminUsername: e.target.value }))} className="mono" />
                  </Field>
                  <Field label="Admin password" required error={errors.windowsAdminPassword} hint="12+ chars. Set on first boot via startup script (not the metadata sysprep).">
                    <Input type="password" value={answers.windowsAdminPassword} onChange={(e) => setAnswers((a) => ({ ...a, windowsAdminPassword: e.target.value }))} className="mono" placeholder="•••••••••••" />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="SSH username" required>
                    <Input value={answers.sshUsername} onChange={(e) => setAnswers((a) => ({ ...a, sshUsername: e.target.value }))} className="mono" />
                  </Field>
                  <Field label="SSH public key" required error={errors.sshPublicKey} hint="Paste your ~/.ssh/id_ed25519.pub.">
                    <Input value={answers.sshPublicKey} onChange={(e) => setAnswers((a) => ({ ...a, sshPublicKey: e.target.value }))} className="mono" placeholder="ssh-ed25519 AAAA…" />
                  </Field>
                </>
              )}
            </div>
          )}

          {pageIdx === 3 && (
            <div className="col gap-3">
              <Field label="Machine type" required>
                <Select options={MACHINE_OPTIONS} value={answers.machineType} onValueChange={(v) => setAnswers((a) => ({ ...a, machineType: v }))} ariaLabel="Machine type" />
              </Field>
              <Field label="Boot disk (GB)">
                <Input type="number" value={String(answers.diskGb)} onChange={(e) => setAnswers((a) => ({ ...a, diskGb: Number(e.target.value) || 20 }))} className="mono" />
              </Field>
              <Field label="Boot disk type">
                <Select options={DISK_TYPE_OPTIONS} value={answers.diskType} onValueChange={(v) => setAnswers((a) => ({ ...a, diskType: v as Answers["diskType"] }))} ariaLabel="Disk type" />
              </Field>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={answers.publicIp} onChange={(e) => setAnswers((a) => ({ ...a, publicIp: e.target.checked }))} />
                <span>Attach ephemeral public IP</span>
              </label>
              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 4 }}>Firewall (via network tags)</div>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={answers.allowIapSsh} onChange={(e) => setAnswers((a) => ({ ...a, allowIapSsh: e.target.checked }))} />
                <span>Tag "iap-ssh" — allows SSH via IAP tunnel (if the VPC has the rule set)</span>
              </label>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={answers.allowHttp} onChange={(e) => setAnswers((a) => ({ ...a, allowHttp: e.target.checked }))} />
                <span>Tag "http-server" — GCP's built-in rule opens TCP/80</span>
              </label>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={answers.allowHttps} onChange={(e) => setAnswers((a) => ({ ...a, allowHttps: e.target.checked }))} />
                <span>Tag "https-server" — GCP's built-in rule opens TCP/443</span>
              </label>
            </div>
          )}

          {onReview && (
            <div className="col gap-3">
              <div className="col gap-1" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
                <ReviewRow label="Name" value={answers.name} />
                <ReviewRow label="Region / Zone" value={`${answers.region} / ${answers.zone}`} />
                <ReviewRow label="Environment" value={envs?.find((e) => e.key === answers.envKey)?.name ?? answers.envKey} />
                <ReviewRow label="Network / subnet" value={`${answers.networkName} / ${answers.subnetName}`} />
                <ReviewRow label="Image" value={answers.image} />
                <ReviewRow label="Machine type" value={answers.machineType} />
                <ReviewRow label="Disk" value={`${answers.diskGb} GB ${answers.diskType}`} />
                <ReviewRow label="Public IP" value={answers.publicIp ? "yes (ephemeral)" : "no"} />
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
