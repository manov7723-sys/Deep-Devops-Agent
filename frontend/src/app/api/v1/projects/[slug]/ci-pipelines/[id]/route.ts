import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

const FileEntry = z.object({ path: z.string().min(1), content: z.string() });
const PatchBody = z.object({
  name: z.string().min(1).optional(),
  files: z.array(FileEntry).optional(),
  agentReview: z.boolean().optional(),
});

async function load(slug: string, id: string, role: "viewer" | "developer") {
  const gate = await requireProjectAccess(slug, role);
  if (!gate.ok) return { error: NextResponse.json({ ok: false }, { status: gate.status }) };
  const row = await prisma.ciPipeline.findFirst({
    where: { id, projectId: gate.access.project.id },
  });
  if (!row) return { error: NextResponse.json({ ok: false, code: "not_found" }, { status: 404 }) };
  return { gate, row };
}

/** Full pipeline incl. its editable files + cached run stages. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const r = await load(slug, id, "viewer");
  if (r.error) return r.error;
  const p = r.row;
  return NextResponse.json({
    id: p.id, name: p.name, status: p.status, agentReview: p.agentReview,
    branch: p.branch, files: p.files, workflowPath: p.workflowPath,
    runUrl: p.runUrl, conclusion: p.conclusion, stages: p.stages,
    lastError: p.lastError, healAttempts: p.healAttempts,
    updatedAt: p.updatedAt.toISOString(),
  });
}

/** Edit the pipeline: script files, name, and the agent-reviewer toggle. */
export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const r = await load(slug, id, "developer");
  if (r.error) return r.error;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.agentReview !== undefined) data.agentReview = parsed.data.agentReview;
  if (parsed.data.files !== undefined) {
    data.files = parsed.data.files.map((f) => ({ path: f.path.replace(/^\/+/, ""), content: f.content }));
    const wf = parsed.data.files.find((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f.path.replace(/^\/+/, "")));
    data.workflowPath = wf ? wf.path.replace(/^\/+/, "") : null;
  }
  await prisma.ciPipeline.update({ where: { id }, data });
  return NextResponse.json({ ok: true });
}

/** Remove a saved pipeline. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const r = await load(slug, id, "developer");
  if (r.error) return r.error;
  await prisma.ciPipeline.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
