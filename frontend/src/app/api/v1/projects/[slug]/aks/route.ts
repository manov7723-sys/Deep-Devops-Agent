import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { CreateAksRequest } from "@/lib/api/schemas/connectivity-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import {
  buildAksTerraform,
  AKS_DEFAULTS,
  AKS_VM_SIZES,
  AKS_K8S_VERSIONS,
  AKS_REGIONS,
  AKS_DISK_SIZES,
  type AksSpec,
} from "@/lib/devops/aks";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import {
  listAksSupportedVersions,
  listAzureResourceGroups,
  listAzureStorageAccounts,
  listVmSkuZones,
  listVmSkusInLocation,
  getVmSkuEphemeralCapacity,
  ensureAzureTfBackend,
} from "@/lib/cloud/azure-arm";

/**
 * Form defaults + option lists for the AKS creation form.
 *
 * When called with `?location=<region>` AND the project has a connected Azure
 * subscription, the returned `kubernetesVersions` list is fetched live from
 * ARM for that region — AKS deprecates two minors a year, staggered per
 * region, and the static list is only used as a fallback. `versionsSource`
 * tells the caller which one they got so the UI can note "live" vs "cached".
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const url = new URL(req.url);
  const location = url.searchParams.get("location")?.trim() || AKS_DEFAULTS.location;

  let kubernetesVersions: string[] = AKS_K8S_VERSIONS;
  let versionsSource: "live" | "static" = "static";
  let versionsNote: string | undefined;

  // Live ARM lookups so the wizard can offer real choices instead of asking
  // the user to type names blindly. `storageAccounts` powers the new
  // "terraform state" step's "use existing" branch; the same list would make
  // the plain "resource group" step live-selectable too.
  let storageAccounts: Array<{ name: string; resourceGroup: string; location: string }> = [];
  let resourceGroups: Array<{ name: string; location: string }> = [];
  let storageNote: string | undefined;

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "azure" },
    select: { id: true, accountRef: true },
  });
  if (cp?.accountRef) {
    const tok = await getAzureAccessToken(cp.id);
    if (tok.ok) {
      const live = await listAksSupportedVersions(tok.accessToken, cp.accountRef, location);
      if (live.ok && live.versions.length > 0) {
        kubernetesVersions = live.versions.filter((v) => !v.isPreview).map((v) => v.version);
        versionsSource = "live";
      } else if (!live.ok) {
        versionsNote = `Falling back to the built-in list — ARM says: ${live.error}`;
      }
      const sas = await listAzureStorageAccounts(tok.accessToken, cp.accountRef);
      if (sas.ok) storageAccounts = sas.accounts;
      else storageNote = sas.error;
      const rgs = await listAzureResourceGroups(tok.accessToken, cp.accountRef);
      if (rgs.ok) resourceGroups = rgs.resourceGroups;
    }
  }

  return NextResponse.json({
    defaults: AKS_DEFAULTS,
    vmSizes: AKS_VM_SIZES,
    kubernetesVersions,
    versionsSource,
    versionsNote,
    regions: AKS_REGIONS,
    diskSizes: AKS_DISK_SIZES,
    storageAccounts,
    resourceGroups,
    storageNote,
  });
}

/** Generate the AKS Terraform tree from the wizard answers. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = CreateAksRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const a = parsed.data;
  if (a.maxNodes < a.minNodes || a.desiredNodes < a.minNodes || a.desiredNodes > a.maxNodes) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: "Node counts must satisfy min ≤ desired ≤ max.",
      },
      { status: 400 },
    );
  }

  // Guard the "Entra only" foot-gun. Turning on `disable_local_accounts`
  // WITHOUT also supplying an `admin_group_object_ids` binds the cluster's
  // access to a set of AAD users that starts empty — the cluster is
  // successfully created and NO ONE can `kubectl` it, including the app
  // itself. It looks perfect in the Portal and fails silently at every
  // request afterward.
  //
  // The wizard doesn't collect an admin group today, so this combination is
  // ALWAYS a lockout in practice. Reject it at the door with the fix in the
  // message rather than surface a cluster nobody can talk to.
  if (a.disableLocalAccounts === true) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message:
          "Disabling local accounts requires an Entra ID admin group (admin_group_object_ids) — otherwise the cluster is created but nobody can access it. The wizard doesn't collect that group yet. Choose 'Keep local accounts' for now; we'll grow the field before turning this on by default.",
      },
      { status: 400 },
    );
  }

  // dns_service_ip must fall inside service_cidr. AKS enforces this at apply
  // time and errors half-way through with a message that reads like a networking
  // outage; catching it here turns a red mid-apply failure into a clear form
  // error before any resource is provisioned.
  if (a.serviceCidr && a.dnsServiceIp && !ipInCidr(a.dnsServiceIp, a.serviceCidr)) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: `dns_service_ip "${a.dnsServiceIp}" must lie inside service_cidr "${a.serviceCidr}". The standard pairing is CIDR .0/16 with dns_service_ip .0.10 (e.g. 10.100.0.0/16 + 10.100.0.10).`,
      },
      { status: 400 },
    );
  }

  // Live-check the requested Kubernetes version against AKS's own supported
  // list for the location — the static AKS_K8S_VERSIONS drifts as AKS
  // deprecates minors (two per year, staggered per region), and the first sign
  // is a red Terraform failure 30s into the apply. Auto-heal by rewriting to
  // the region's default when the requested version isn't in the live list,
  // rather than aborting: the wizard has already been submitted and the user
  // just wants a cluster, not a lecture on release cadence.
  let versionSubstitution: { from: string; to: string; reason: string } | null = null;
  // Same shape: "we quietly turned zones off because your sub can't do them
  // for this SKU here". The wizard shows this back to the user so it's not a
  // silent choice change.
  let zonesSubstitution: { from: boolean; to: boolean; reason: string } | null = null;
  // Same idea for VM SKUs. AKS refuses SKUs whose quota is 0 or that just
  // aren't offered in this sub/region.
  let vmSizeSubstitutions:
    | Array<{ field: "vmSize" | "appVmSize"; from: string; to: string; reason: string }>
    | null = null;
  // "Ephemeral OS won't fit on this SKU → we swapped to Managed" — same
  // shape as the other substitution reports.
  let osDiskSubstitution: { from: string; to: string; reason: string } | null = null;
  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "azure" },
    select: { id: true, accountRef: true },
  });
  if (cp?.accountRef) {
    const tok = await getAzureAccessToken(cp.id);
    if (tok.ok) {
      const live = await listAksSupportedVersions(tok.accessToken, cp.accountRef, a.location);
      if (live.ok && live.versions.length > 0) {
        const stableSupported = live.versions.filter((v) => !v.isPreview).map((v) => v.version);
        if (!stableSupported.includes(a.kubernetesVersion)) {
          const preferred =
            live.versions.find((v) => v.isDefault && !v.isPreview)?.version ??
            stableSupported[0];
          if (preferred) {
            versionSubstitution = {
              from: a.kubernetesVersion,
              to: preferred,
              reason: `AKS in ${a.location} no longer accepts ${a.kubernetesVersion}. Available: ${stableSupported.join(", ")}.`,
            };
            a.kubernetesVersion = preferred;
          }
        }
      }

      // VM SKU availability check. AKS refuses B-series in many
      // subscriptions with a 400 that lists every supported SKU EXCEPT
      // B-series, and the same shape fires for any SKU whose quota is 0 or
      // that's simply not offered in this region. Substitute upward to the
      // first PREFERRED SKU that IS available. Preferences ordered so a
      // 2-vCPU workload doesn't get silently upgraded to 8 vCPU:
      //   D2s_v3 → DS2_v2 → D2_v3 → A2_v2 → whatever the first "small"
      //   SKU in the sub-region is.
      const PREFERRED_SUBSTITUTES = [
        "Standard_D2s_v3",
        "Standard_DS2_v2",
        "Standard_D2_v3",
        "Standard_D2as_v5",
        "Standard_A2_v2",
        "Standard_A2m_v2",
      ];
      const vmSubs: Array<{ field: "vmSize" | "appVmSize"; from: string; to: string; reason: string }> = [];
      const skus = await listVmSkusInLocation(tok.accessToken, cp.accountRef, a.location);
      if (skus.ok && skus.skus.length > 0) {
        const available = new Set(skus.skus.map((s) => s.toLowerCase()));
        const substitute = (label: "vmSize" | "appVmSize", requested: string): string => {
          if (available.has(requested.toLowerCase())) return requested;
          const alt =
            PREFERRED_SUBSTITUTES.find((s) => available.has(s.toLowerCase())) ??
            // Fall back to the smallest ARM-listed SKU whose name starts with
            // "Standard_D" and looks like a 2-4 vCPU size — better than
            // reaching for an M-series 208-vCPU giant.
            skus.skus.find((s) => /^standard_d[24]s?_v[35]$/i.test(s)) ??
            skus.skus[0];
          vmSubs.push({
            field: label,
            from: requested,
            to: alt,
            reason: `Azure won't accept "${requested}" for AKS in ${a.location} on this subscription (SKU not offered or zero quota). Substituted the closest smaller-tier alternative.`,
          });
          return alt;
        };
        a.vmSize = substitute("vmSize", a.vmSize);
        if (a.appNodePool && a.appVmSize) {
          a.appVmSize = substitute("appVmSize", a.appVmSize);
        }
      }
      // Expose the substitutions on the response, same pattern as
      // versionSubstitution and zonesSubstitution.
      vmSizeSubstitutions = vmSubs.length ? vmSubs : null;

      // Ephemeral OS disk fit check. AKS returns VMCannotFitEphemeralOSDisk
      // when the requested disk size exceeds BOTH the SKU's cache and its
      // temp disk. Cache/temp are ARM Compute SKU capabilities we can read
      // ahead of time. When it won't fit, silently downgrade to Managed so
      // the apply proceeds — Managed is universally supported and only
      // marginally slower/costlier. Reported back so the swap isn't hidden.
      if ((a.systemOsDiskType ?? "Managed") === "Ephemeral") {
        const cap = await getVmSkuEphemeralCapacity(
          tok.accessToken,
          cp.accountRef,
          a.location,
          a.vmSize,
        );
        if (cap.ok && (cap.cacheGiB !== null || cap.tempDiskGiB !== null)) {
          const requested = a.systemDiskSize ?? 30;
          const maxAvail = Math.max(cap.cacheGiB ?? 0, cap.tempDiskGiB ?? 0);
          if (requested > maxAvail) {
            osDiskSubstitution = {
              from: "Ephemeral",
              to: "Managed",
              reason: `Ephemeral OS on "${a.vmSize}" tops out at ${maxAvail} GB (cache ${cap.cacheGiB ?? "?"} GB, temp ${cap.tempDiskGiB ?? "?"} GB). Your ${requested} GB disk needs Managed; the alternative is a bigger VM.`,
            };
            a.systemOsDiskType = "Managed";
          }
        }
      }

      // Zone availability is per-subscription per-region per-VM-SKU, and ARM
      // is the only authority. Trial subscriptions in eastus report NO zones
      // for common B-series SKUs even though the region generally has them.
      // If the user asked for zones and none exist, silently downgrade — the
      // apply otherwise dies with AvailabilityZoneNotSupported ~45s in, after
      // Log Analytics has been created. Reported back so it isn't hidden.
      if (a.zones === true) {
        const skuZones = await listVmSkuZones(
          tok.accessToken,
          cp.accountRef,
          a.location,
          a.vmSize,
        );
        if (skuZones.ok && skuZones.zones.length === 0) {
          zonesSubstitution = {
            from: true,
            to: false,
            reason: `AKS in ${a.location} advertises no availability zones for VM size "${a.vmSize}" on this subscription. Common for trial subscriptions — either request a quota increase, pick a different region, or accept single-zone.`,
          };
          a.zones = false;
        }
      }
    }
  }

  const spec: AksSpec = {
    name: a.name,
    location: a.location,
    kubernetesVersion: a.kubernetesVersion,
    vmSize: a.vmSize,
    desiredNodes: a.desiredNodes,
    minNodes: a.minNodes,
    maxNodes: a.maxNodes,
    resourceGroup: a.resourceGroup,
    createResourceGroup: a.createResourceGroup,
    vnetSubnetId: a.vnetSubnetId?.trim() || undefined,
    // Production options.
    environment: a.environment,
    team: a.team,
    costCenter: a.costCenter,
    skuTier: a.skuTier,
    zones: a.zones,
    automaticUpgrade: a.automaticUpgrade,
    networkPolicy: a.networkPolicy,
    serviceCidr: a.serviceCidr,
    dnsServiceIp: a.dnsServiceIp,
    privateCluster: a.privateCluster,
    authorizedIpRanges: a.authorizedIpRanges,
    azureRbac: a.azureRbac,
    disableLocalAccounts: a.disableLocalAccounts,
    workloadIdentity: a.workloadIdentity,
    azurePolicy: a.azurePolicy,
    systemDiskSize: a.systemDiskSize,
    systemOsDiskType: a.systemOsDiskType,
    systemMaxPods: a.systemMaxPods,
    appNodePool: a.appNodePool,
    appVmSize: a.appVmSize,
    appSpot: a.appSpot,
    appMinNodes: a.appMinNodes,
    appMaxNodes: a.appMaxNodes,
    monitoring: a.monitoring,
    keyVaultSecretsProvider: a.keyVaultSecretsProvider,
    kedaVpa: a.kedaVpa,
  };

  // ── Terraform state backend ─────────────────────────────────────────
  //
  // Every cluster-creation run picks a fresh state backend rather than
  // silently trusting the env's stored one — the "stored account no longer
  // exists" incident (2026-07) turned a Terraform apply into an unrecoverable
  // `no such host` mid-flight failure and left resources orphaned. The wizard
  // now offers three explicit modes:
  //
  //   • "create"   — ensure a fresh Storage account + container exist BEFORE
  //                  terraform init runs. Idempotent, so a retry with the
  //                  same name reuses whatever ARM already has.
  //   • "existing" — reuse a specific SA the user picked. We verify it exists
  //                  and belongs to the connected subscription, and only THEN
  //                  write it to the env. No blind trust.
  //   • "local"    — omit the backend block; state lives on the runner disk.
  //                  Fine for demos.
  //
  // Whatever mode is chosen ALWAYS overwrites the env's tfBackendAzure* fields
  // so the next generate never inherits a stale account. This is the single
  // point of truth for "where does state go" going forward.
  let backendResult: {
    mode: "local" | "existing" | "create";
    storageAccount?: string;
    container?: string;
    resourceGroup?: string;
    created?: { resourceGroup: boolean; storageAccount: boolean; container: boolean };
  } | null = null;

  const mode = a.stateBackendMode ?? "local";
  if (mode !== "local") {
    if (!cp?.accountRef) {
      return NextResponse.json(
        {
          ok: false,
          code: "azure_not_connected",
          message: `Terraform state mode "${mode}" needs a connected Azure subscription — connect one on the Cloud providers page or switch state to "local".`,
        },
        { status: 400 },
      );
    }
    const tok = await getAzureAccessToken(cp.id);
    if (!tok.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "azure_token_failed",
          message: `Couldn't get an Azure access token to prepare the state backend: ${tok.error}`,
        },
        { status: 502 },
      );
    }
    const storageAccount = a.stateStorageAccount?.trim();
    const container = (a.stateContainer?.trim() || "tfstate").toLowerCase();
    if (!storageAccount) {
      return NextResponse.json(
        {
          ok: false,
          code: "invalid_request",
          message:
            "Terraform state backend needs a storage account name. Pick 'Local' if you'd rather skip remote state.",
        },
        { status: 400 },
      );
    }
    // For "existing" mode we look up the SA's own resource group from the
    // subscription rather than trust a caller-supplied one — an ARM lookup
    // gives the authoritative RG (and confirms the SA exists at all before
    // we ever write it to the env).
    let stateRg = (a.stateResourceGroup?.trim() || a.resourceGroup).trim();
    if (mode === "existing") {
      const sas = await listAzureStorageAccounts(tok.accessToken, cp.accountRef);
      if (!sas.ok) {
        return NextResponse.json(
          {
            ok: false,
            code: "backend_lookup_failed",
            message: `Couldn't list storage accounts to verify "${storageAccount}" exists: ${sas.error}`,
          },
          { status: 502 },
        );
      }
      const match = sas.accounts.find((s) => s.name === storageAccount);
      if (!match) {
        return NextResponse.json(
          {
            ok: false,
            code: "backend_not_found",
            message: `Storage account "${storageAccount}" is not visible in this Azure subscription. Pick 'Create new' to make one, or choose a different account.`,
          },
          { status: 404 },
        );
      }
      stateRg = match.resourceGroup;
    }
    const ensured = await ensureAzureTfBackend({
      token: tok.accessToken,
      subscriptionId: cp.accountRef,
      resourceGroup: stateRg,
      location: a.location,
      storageAccount,
      container,
    });
    if (!ensured.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "backend_ensure_failed",
          message: `Preparing the Terraform state backend failed: ${ensured.error}`,
        },
        { status: 409 },
      );
    }
    spec.stateResourceGroup = stateRg;
    spec.stateStorageAccount = storageAccount;
    spec.stateContainer = container;
    backendResult = {
      mode,
      storageAccount,
      container,
      resourceGroup: stateRg,
      created: ensured.created,
    };
  } else {
    backendResult = { mode: "local" };
  }

  // Persist the chosen backend onto the env — future generates read this back.
  // Explicitly writing NULL for "local" mode is deliberate: it clears any
  // stale stored account so a later run starts clean.
  if (a.envKey) {
    const env = await envBySlugAndKey(gate.access.project.id, a.envKey);
    if (env) {
      await prisma.env.update({
        where: { id: env.id },
        data: {
          tfBackendAzureResourceGroup: mode === "local" ? null : (spec.stateResourceGroup ?? null),
          tfBackendAzureStorageAccount: mode === "local" ? null : (spec.stateStorageAccount ?? null),
          tfBackendAzureContainer: mode === "local" ? null : (spec.stateContainer ?? null),
        },
      });
    }
  }

  const files = buildAksTerraform(spec);

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "aks.terraform_generated",
    targetType: "aks_cluster",
    targetId: `${slug}/${a.name}`,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      resourceGroup: a.resourceGroup,
      location: a.location,
      version: a.kubernetesVersion,
      vmSize: a.vmSize,
    },
  });

  return NextResponse.json({
    ok: true,
    clusterName: a.name,
    location: a.location,
    fileCount: Object.keys(files).length,
    files,
    hasRemoteState: !!(spec.stateStorageAccount && spec.stateContainer),
    // Reported so the UI can show "we changed 1.30 → 1.32 because AKS
    // deprecated 1.30 in this region" rather than silently rewriting.
    versionSubstitution,
    zonesSubstitution,
    vmSizeSubstitutions,
    osDiskSubstitution,
    // Which backend the run chose, and what (if anything) was created for it.
    // The wizard's success screen surfaces this so the user knows a real SA
    // exists before terraform init ever runs.
    backend: backendResult,
  });
}

/**
 * Basic CIDR containment: is `ip` inside `cidr`? Both must be IPv4 dotted
 * quads; anything else is treated as not-contained (fail closed, since the
 * only caller is a validator and a false-positive would mislead the user).
 */
function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr ?? "", 10);
  if (!range || Number.isNaN(bits) || bits < 0 || bits > 32) return false;
  const toInt = (s: string): number | null => {
    const parts = s.split(".");
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
      const o = parseInt(p, 10);
      if (Number.isNaN(o) || o < 0 || o > 255 || String(o) !== p.trim()) return null;
      n = (n << 8) | o;
    }
    // >>> 0 forces the JS bit-shifted signed int back to unsigned so masks
    // compare correctly for CIDRs whose network int has the sign bit set.
    return n >>> 0;
  };
  const ipInt = toInt(ip);
  const rangeInt = toInt(range);
  if (ipInt === null || rangeInt === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}
