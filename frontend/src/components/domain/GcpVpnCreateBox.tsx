"use client";

/**
 * GCP OpenVPN endpoint launch wizard, embedded in chat via the
 * ```gcp-vpn-create``` fence. Mirrors ClientVpnCreateBox but for GCP —
 * self-hosted OpenVPN on a small Compute Engine VM (GCP has no managed
 * Client VPN equivalent).
 */
import { useEffect, useMemo, useState } from "react";
import { Block, Btn, Field, Input, Select, type SelectOption } from "@/components/ui";
import { ApprovalCard } from "@/components/domain/ApprovalCard";
import { useProjectEnvs } from "@/hooks/queries/project";
import { useGcpNetworksInRegion, useSubmitGcpVpn } from "@/hooks/queries/network";
import { useGcpContext, useSaveGcpContext } from "@/hooks/queries/gcp";
import { GCP_REGIONS } from "@/lib/gcp-regions";

type Answers = {
  name: string;
  region: string;
  zone: string;
  envKey: string;
  networkName: string;
  subnetName: string;
  vpcCidr: string;
  machineType: string;
  clientCidr: string;
  certOwnerName: string;
  splitTunnel: boolean;
  transportProtocol: "udp" | "tcp";
  vpnPort: 1194 | 443;
  sourceRanges: string;
};

const PAGE_TITLES = ["Name & zone", "Network", "Tunnel & certs", "Review"];

const MACHINE_OPTIONS: SelectOption[] = [
  { value: "e2-micro", label: "e2-micro — 2 vCPU / 1 GB (~$7/mo, plenty for <20 concurrent clients)" },
  { value: "e2-small", label: "e2-small — 2 vCPU / 2 GB (~$14/mo, default)" },
  { value: "e2-medium", label: "e2-medium — 2 vCPU / 4 GB (~$25/mo, more headroom)" },
];

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

export function GcpVpnCreateBox({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const gcpCtx = useGcpContext(slug);
  const saveGcp = useSaveGcpContext(slug);
  const submit = useSubmitGcpVpn(slug);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [answers, setAnswers] = useState<Answers>({
    name: "team-vpn",
    region: "us-central1",
    zone: "us-central1-a",
    envKey: "",
    networkName: "",
    subnetName: "",
    vpcCidr: "",
    machineType: "e2-small",
    clientCidr: "10.100.0.0/22",
    certOwnerName: "",
    splitTunnel: true,
    transportProtocol: "udp",
    vpnPort: 1194,
    sourceRanges: "0.0.0.0/0",
  });
  const [pageIdx, setPageIdx] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<{ approvalId: string; repoPath: string; repoFullName: string } | null>(null);

  const gcpProjectId = gcpCtx.data?.gcpProjectId ?? null;
  const gcpProjects = gcpCtx.data?.projects ?? [];
  const netsQuery = useGcpNetworksInRegion(slug, gcpProjectId, answers.region || null);

  useEffect(() => {
    if (answers.envKey || !envs?.length) return;
    setAnswers((a) => ({ ...a, envKey: envs[0]!.key }));
  }, [envs, answers.envKey]);

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
  // The /gcp/networks endpoint pre-extracts the short network name into
  // `subnetwork.network`, so we filter by pickedNet.name — NOT selfLink.
  // (The GcpVmCreateBox has the same field but compared against selfLink,
  // which silently returned zero subnets. Same fix applies there.)
  const subnetsForNet = pickedNet ? subnetworks.filter((s) => s.network === pickedNet.name) : [];
  const networkOptions: SelectOption[] = networks.map((n) => ({ value: n.name, label: n.name }));
  const subnetOptions: SelectOption[] = subnetsForNet.map((s) => ({ value: s.name, label: `${s.name} · ${s.ipCidrRange}` }));

  // Auto-fill vpcCidr from the picked subnet — the "reach the VPC" route
  // needs the subnet CIDR, and the wizard shouldn't force the user to look
  // it up manually when it's already in the subnet metadata.
  useEffect(() => {
    if (!answers.subnetName) return;
    const s = subnetsForNet.find((s) => s.name === answers.subnetName);
    if (s?.ipCidrRange && s.ipCidrRange !== answers.vpcCidr) {
      setAnswers((a) => ({ ...a, vpcCidr: s.ipCidrRange }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers.subnetName, subnetsForNet.length]);

  const errors: Partial<Record<keyof Answers, string>> = {};
  if (pageIdx === 0) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(answers.name.trim())) errors.name = "Lowercase, dashes, 2-41 chars.";
    if (!answers.region) errors.region = "Pick a region.";
    if (!answers.zone) errors.zone = "Pick a zone.";
    if (!answers.envKey) errors.envKey = "Pick an env.";
  }
  // Guard the network page — without a GCP project id the network dropdown
  // has nothing to load, and the user gets stuck on page 2.
  const missingGcpProject = pageIdx === 0 && !gcpProjectId;
  if (pageIdx === 1) {
    if (!answers.networkName) errors.networkName = "Pick a network.";
    if (!answers.subnetName) errors.subnetName = "Pick a subnet.";
    if (!answers.vpcCidr) errors.vpcCidr = "Subnet CIDR is required (auto-filled from the picked subnet).";
  }
  if (pageIdx === 2) {
    const cidrRe = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
    if (!cidrRe.test(answers.clientCidr.trim())) errors.clientCidr = "Not a valid IPv4 CIDR (e.g. 10.100.0.0/22).";
    // Source ranges is a comma-separated list.
    for (const r of answers.sourceRanges.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!cidrRe.test(r)) {
        errors.sourceRanges = `"${r}" is not a valid CIDR.`;
        break;
      }
    }
  }
  const pageHasError = Object.keys(errors).length > 0 || missingGcpProject;
  const onReview = pageIdx === PAGE_TITLES.length - 1;

  async function handleCreate() {
    setServerError(null);
    try {
      const sourceRanges = answers.sourceRanges
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await submit.mutateAsync({
        name: answers.name.trim(),
        envKey: answers.envKey,
        region: answers.region,
        zone: answers.zone,
        networkName: answers.networkName,
        subnetName: answers.subnetName,
        vpcCidr: answers.vpcCidr,
        machineType: answers.machineType,
        clientCidr: answers.clientCidr.trim(),
        certOwnerName: answers.certOwnerName.trim() || undefined,
        splitTunnel: answers.splitTunnel,
        transportProtocol: answers.transportProtocol,
        vpnPort: answers.vpnPort,
        sourceRanges: sourceRanges.length ? sourceRanges : undefined,
      });
      if (res.approvalId) {
        setResult({ approvalId: res.approvalId, repoPath: res.repoPath ?? "", repoFullName: res.repoFullName ?? "" });
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "GCP VPN submit failed.");
    }
  }

  if (result) {
    return (
      <Block>
        <Block.Header>
          <Block.Title sub={`Files committed to ${result.repoFullName}/${result.repoPath}. Approve to run terraform apply.`}>
            GCP OpenVPN submitted — pending approval
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
        <Block.Title sub="GCP has no managed Client VPN — we spin up a small e2-small VM running OpenVPN. Same .ovpn download UX as AWS.">
          Create GCP OpenVPN endpoint
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
              <Field label="Zone" required error={errors.zone} hint="Pick a zone in the region. The VM lives in one zone.">
                <Select options={zoneOptions} value={answers.zone} onValueChange={(v) => setAnswers((a) => ({ ...a, zone: v }))} ariaLabel="Zone" />
              </Field>
              <Field label="Environment" required error={errors.envKey}>
                <Select options={envOptions} value={answers.envKey} onValueChange={(v) => setAnswers((a) => ({ ...a, envKey: v }))} ariaLabel="Env" placeholder="Pick an env…" />
              </Field>
              <Field
                label="GCP project"
                required
                hint={
                  gcpCtx.isLoading
                    ? "Loading GCP projects…"
                    : gcpCtx.data?.connected === false
                    ? "GCP isn't connected. Connect it on the Cloud providers page first."
                    : gcpProjects.length === 0
                    ? "No projects visible from the connected identity. Check GCP IAM."
                    : gcpProjectId
                    ? `Selected. Saved to the project — VM + VPC wizards use the same pick.`
                    : "Pick which GCP project this VPN goes into. Saved to the project — reused across wizards."
                }
              >
                <Select
                  options={gcpProjects.map((p) => ({ value: p.projectId, label: `${p.name || p.projectId} · ${p.projectId}` }))}
                  value={gcpProjectId ?? ""}
                  onValueChange={async (v) => {
                    setSaveError(null);
                    try {
                      await saveGcp.mutateAsync({ gcpProjectId: v });
                      // Reset picked network/subnet — they belong to the OLD project.
                      setAnswers((a) => ({ ...a, networkName: "", subnetName: "", vpcCidr: "" }));
                    } catch (e) {
                      setSaveError(e instanceof Error ? e.message : "Could not save GCP project.");
                    }
                  }}
                  ariaLabel="GCP project"
                  placeholder={gcpCtx.isLoading ? "Loading…" : "Pick a GCP project…"}
                  disabled={saveGcp.isPending || gcpCtx.isLoading || gcpProjects.length === 0}
                />
              </Field>
              {saveError && <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">{saveError}</p>}
              {gcpCtx.data?.authError && (
                <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">GCP: {gcpCtx.data.authError}</p>
              )}
            </div>
          )}

          {pageIdx === 1 && (
            <div className="col gap-3">
              <Field
                label="Network"
                required
                error={errors.networkName}
                hint={
                  !gcpProjectId
                    ? "No active GCP project — set one on the Cloud providers page."
                    : netsQuery.isLoading
                    ? "Loading networks…"
                    : networks.length === 0
                    ? `No networks in ${answers.region}. Create one first (say 'create gcp vpc').`
                    : `${networks.length} network${networks.length === 1 ? "" : "s"} in ${answers.region}.`
                }
              >
                <Select options={networkOptions} value={answers.networkName} onValueChange={(v) => setAnswers((a) => ({ ...a, networkName: v, subnetName: "", vpcCidr: "" }))} ariaLabel="Network" placeholder="Pick a network…" disabled={networkOptions.length === 0} />
              </Field>
              <Field
                label="Subnet"
                required
                error={errors.subnetName}
                hint={(() => {
                  if (!answers.networkName) return "Pick a network first.";
                  if (subnetOptions.length > 0) return `${subnetOptions.length} subnet${subnetOptions.length === 1 ? "" : "s"} in this network + region.`;
                  // Diagnostic: subnetworks list may be non-empty overall but
                  // none match the picked network. Show the actual network
                  // names the API returned so mismatches are immediately obvious.
                  if (subnetworks.length === 0) {
                    return `No subnets in ${answers.region} for the picked GCP project. GCP subnets are region-scoped — try changing the region on page 1.`;
                  }
                  const foundNets = Array.from(new Set(subnetworks.map((s) => s.network))).join(", ");
                  return `API returned ${subnetworks.length} subnet${subnetworks.length === 1 ? "" : "s"} in ${answers.region} — but they belong to network${foundNets.includes(",") ? "s" : ""}: ${foundNets}. Not "${answers.networkName}". Either the picked network has no subnet in this region, or a Shared VPC's subnets live in the host project.`;
                })()}
              >
                <Select options={subnetOptions} value={answers.subnetName} onValueChange={(v) => setAnswers((a) => ({ ...a, subnetName: v }))} ariaLabel="Subnet" placeholder="Pick a subnet…" disabled={!answers.networkName || subnetOptions.length === 0} />
              </Field>
              <Field label="Subnet CIDR (auto-filled)" hint="Advertised to VPN clients so they can reach VMs on this subnet.">
                <Input value={answers.vpcCidr} onChange={(e) => setAnswers((a) => ({ ...a, vpcCidr: e.target.value }))} className="mono" placeholder="10.0.0.0/24" />
              </Field>
            </div>
          )}

          {pageIdx === 2 && (
            <div className="col gap-3">
              <Field label="Cert owner name" hint="Used as the CN prefix on the CA + server + initial client cert. Leave blank to use the endpoint name.">
                <Input value={answers.certOwnerName} onChange={(e) => setAnswers((a) => ({ ...a, certOwnerName: e.target.value }))} className="mono" placeholder={answers.name} />
              </Field>
              <Field label="VM size">
                <Select options={MACHINE_OPTIONS} value={answers.machineType} onValueChange={(v) => setAnswers((a) => ({ ...a, machineType: v }))} ariaLabel="Machine type" />
              </Field>
              <Field label="Client CIDR" required error={errors.clientCidr} hint="Pool of IPs assigned to connected clients. Must not overlap with your VPC.">
                <Input value={answers.clientCidr} onChange={(e) => setAnswers((a) => ({ ...a, clientCidr: e.target.value }))} className="mono" />
              </Field>
              <Field label="Transport">
                <Select
                  options={[
                    { value: "udp", label: "UDP (default, faster)" },
                    { value: "tcp", label: "TCP (slower, works through more restrictive firewalls)" },
                  ]}
                  value={answers.transportProtocol}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, transportProtocol: v as "udp" | "tcp" }))}
                  ariaLabel="Transport"
                />
              </Field>
              <Field label="Port">
                <Select
                  options={[
                    { value: "1194", label: "1194 (default OpenVPN port)" },
                    { value: "443", label: "443 (TCP only — blends with HTTPS on restrictive networks)" },
                  ]}
                  value={String(answers.vpnPort)}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, vpnPort: Number(v) as 1194 | 443 }))}
                  ariaLabel="Port"
                />
              </Field>
              <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={answers.splitTunnel} onChange={(e) => setAnswers((a) => ({ ...a, splitTunnel: e.target.checked }))} />
                <span>Split-tunnel (only VPC traffic goes through the VPN — recommended)</span>
              </label>
              <Field label="Source IP ranges" error={errors.sourceRanges} hint="Comma-separated CIDRs allowed to connect. Cert auth still gates access; this is an extra layer.">
                <Input value={answers.sourceRanges} onChange={(e) => setAnswers((a) => ({ ...a, sourceRanges: e.target.value }))} className="mono" placeholder="0.0.0.0/0" />
              </Field>
            </div>
          )}

          {onReview && (
            <div className="col gap-3">
              <div className="col gap-1" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
                <ReviewRow label="Name" value={answers.name} />
                <ReviewRow label="Region / Zone" value={`${answers.region} / ${answers.zone}`} />
                <ReviewRow label="Environment" value={envs?.find((e) => e.key === answers.envKey)?.name ?? answers.envKey} />
                <ReviewRow label="Network / subnet" value={`${answers.networkName} / ${answers.subnetName}`} />
                <ReviewRow label="Subnet CIDR" value={answers.vpcCidr || "(missing)"} />
                <ReviewRow label="VM size" value={answers.machineType} />
                <ReviewRow label="Client CIDR" value={answers.clientCidr} />
                <ReviewRow label="Transport / port" value={`${answers.transportProtocol.toUpperCase()}/${answers.vpnPort}`} />
                <ReviewRow label="Tunnel mode" value={answers.splitTunnel ? "split (VPC only)" : "full (all client traffic)"} />
                <ReviewRow label="Cert owner" value={answers.certOwnerName.trim() || answers.name} />
                <ReviewRow label="Source ranges" value={answers.sourceRanges || "0.0.0.0/0"} />
              </div>
              <p className="muted" style={{ fontSize: 12.5 }}>
                Cost estimate: ~$8–15/mo per endpoint ({answers.machineType} VM + static IP + egress).
              </p>
              {serverError && <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">{serverError}</p>}
            </div>
          )}

          <div className="row gap-2" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <Btn variant="ghost" onClick={() => setPageIdx((i) => Math.max(0, i - 1))} disabled={pageIdx === 0 || submit.isPending}>Back</Btn>
            {onReview ? (
              <Btn variant="primary" icon="plus" loading={submit.isPending} onClick={handleCreate}>Create VPN</Btn>
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
