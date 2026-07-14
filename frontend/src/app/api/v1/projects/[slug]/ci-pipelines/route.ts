import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

/** List the project's saved CI/CD pipelines (newest first). Bare array for the hook. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const rows = await prisma.ciPipeline.findMany({
    where: { projectId: gate.access.project.id },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      status: true,
      agentReview: true,
      branch: true,
      runUrl: true,
      conclusion: true,
      lastError: true,
      healAttempts: true,
      repo: { select: { fullName: true } },
      updatedAt: true,
      createdAt: true,
    },
  });
  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      agentReview: r.agentReview,
      branch: r.branch,
      runUrl: r.runUrl,
      conclusion: r.conclusion,
      lastError: r.lastError,
      healAttempts: r.healAttempts,
      repoFullName: r.repo.fullName,
      updatedAt: r.updatedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    })),
  );
}
