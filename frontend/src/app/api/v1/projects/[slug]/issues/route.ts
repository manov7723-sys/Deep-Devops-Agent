import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });
  const rows = await prisma.issue.findMany({
    where: { projectId: gate.access.project.id },
    orderBy: [{ state: "asc" }, { updatedAt: "desc" }],
    take: 50,
    include: {
      repo: { select: { name: true, owner: true } },
      reviewedByAgent: { select: { name: true } },
    },
  });
  const items = rows.map((i) => ({
    id: i.id,
    number: i.number,
    title: i.title,
    note: i.note,
    labels: i.labels,
    state: i.state,
    verdict: i.verdict,
    repoName: `${i.repo.owner}/${i.repo.name}`,
    reviewer: i.reviewedByAgent?.name ?? null,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  }));
  return NextResponse.json(items);
}
