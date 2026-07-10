import { NextResponse } from "next/server";
import { CreateProxmoxVmRequest } from "@/lib/api/schemas/connectivity-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { buildProxmoxVmTerraform } from "@/lib/devops/proxmox-vm";
import { getProxmoxOptions } from "@/lib/cloud/proxmox";
import { prisma } from "@/lib/db/prisma";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const STATIC_DATASTORES = ["local-lvm", "local", "local-zfs"];
const STATIC_BRIDGES = ["vmbr0", "vmbr1"];

/**
 * GET  → live option lists for the VM box's selects — the real node(s), storage
 *        pools, bridges and clone templates read from the connected Proxmox
 *        server (falls back to static hints if no provider / API unreachable).
 * POST  → generate the bpg/proxmox Terraform for one VM and return the files.
 *
 * Mirrors the /eks route: this endpoint only GENERATES + returns files; the
 * ClusterChat engine handles push-to-repo and terraform apply generically.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "proxmox" },
    select: { id: true },
  });
  if (!cp) {
    // No Proxmox provider attached yet — hand back static hints so the box still renders.
    return NextResponse.json({
      nodes: [],
      defaultNode: "",
      datastores: STATIC_DATASTORES,
      bridges: STATIC_BRIDGES,
      templates: [],
    });
  }

  const opts = await getProxmoxOptions(cp.id);
  return NextResponse.json({
    nodes: opts.nodes,
    defaultNode: opts.defaultNode,
    datastores: opts.datastores.length ? opts.datastores : STATIC_DATASTORES,
    bridges: opts.bridges.length ? opts.bridges : STATIC_BRIDGES,
    templates: opts.templates,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = CreateProxmoxVmRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const a = parsed.data;
  if (!a.templateVmId && !a.isoFile) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "Provide a template VM id (to clone) or an ISO file." },
      { status: 400 },
    );
  }

  const files = buildProxmoxVmTerraform({
    name: a.name,
    node: a.node,
    cores: a.cores,
    memoryMB: a.memoryMB,
    diskGB: a.diskGB,
    datastore: a.datastore,
    bridge: a.bridge,
    templateVmId: a.templateVmId,
    isoFile: a.isoFile,
    ipv4: a.ipv4,
    gateway: a.gateway,
  });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "proxmox.vm_terraform_generated",
    targetType: "proxmox_vm",
    targetId: `${slug}/${a.name}`,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { node: a.node, cores: a.cores, memoryMB: a.memoryMB, diskGB: a.diskGB },
  });

  // `clusterName` is what the ClusterChat engine reads back (it's cloud-neutral).
  return NextResponse.json({
    ok: true,
    clusterName: a.name,
    fileCount: Object.keys(files).length,
    files,
  });
}
