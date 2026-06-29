import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getGcpAccessToken } from "@/lib/cloud/gcp";
import { listGcpProjects } from "@/lib/cloud/gcp-oauth";

/**
 * Per-project GCP context: which GCP project (+ region) the agent targets. GET
 * returns the live list of GCP projects the account can see plus the saved
 * pick; PATCH saves the selection. accountRef = active GCP project id.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "gcp" },
    select: { id: true, accountRef: true, region: true },
  });
  if (!cp) return NextResponse.json({ ok: true, connected: false });

  const tok = await getGcpAccessToken(cp.id);
  let projects: Array<{ projectId: string; name: string; lifecycleState: string }> = [];
  let authError: string | null = null;
  if (tok.ok) {
    const r = await listGcpProjects(tok.accessToken);
    if (r.ok) projects = r.projects.map((p) => ({ projectId: p.projectId, name: p.name, lifecycleState: p.lifecycleState }));
    else authError = r.error;
  } else {
    authError = tok.error;
  }

  return NextResponse.json({
    ok: true,
    connected: true,
    gcpProjectId: cp.accountRef,
    region: cp.region,
    projects,
    authError,
  });
}

const PatchBody = z.object({
  gcpProjectId: z.string().trim().optional(),
  region: z.string().trim().optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "gcp" },
    select: { id: true },
  });
  if (!cp) return NextResponse.json({ ok: false, code: "no_gcp" }, { status: 404 });

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });

  const data: Record<string, string> = {};
  if (parsed.data.gcpProjectId) data.accountRef = parsed.data.gcpProjectId;
  if (parsed.data.region) data.region = parsed.data.region;
  if (Object.keys(data).length === 0) return NextResponse.json({ ok: false, code: "nothing_to_save" }, { status: 400 });

  await prisma.cloudProvider.update({ where: { id: cp.id }, data });
  return NextResponse.json({ ok: true });
}
