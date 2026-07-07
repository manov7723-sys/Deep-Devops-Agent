import { NextResponse } from "next/server";
import { AttachRepoRequest } from "@/lib/api/schemas/connectivity-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { attachRepoToProject, listReposForProject, setProjectRepo } from "@/lib/repos/repos";
import { audit } from "@/lib/audit/log";
import { recordActivity } from "@/lib/agentops/activity";
import { extractRequestMeta } from "@/lib/auth/request-meta";
import { prisma } from "@/lib/db/prisma";

/** Bare array — `useProjectRepos()` iterates `.map`/`.filter` directly. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const repos = await listReposForProject(gate.access.project.id);
  return NextResponse.json(repos);
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = AttachRepoRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });
  }

  const res = await attachRepoToProject(
    gate.access.session.userId,
    gate.access.project.id,
    parsed.data.repoId,
  );
  if (!res.ok) {
    const status =
      res.code === "repo_not_found" ? 404 :
      res.code === "repo_not_yours" ? 403 :
      409;
    return NextResponse.json({ ok: false, code: res.code }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "repo.attached",
    targetType: "repo",
    targetId: parsed.data.repoId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  // Look up the fullName for a more useful activity row.
  const repo = await prisma.repo.findUnique({
    where: { id: parsed.data.repoId },
    select: { fullName: true },
  });
  await recordActivity({
    projectId: gate.access.project.id,
    actorUserId: gate.access.session.userId,
    action: "attached",
    targetType: "repo",
    targetLabel: repo?.fullName ?? parsed.data.repoId.slice(0, 8),
    icon: "github",
  }).catch(() => {});
  return NextResponse.json({ ok: true });
}

/**
 * PUT — set the project's SINGLE repo (the "Change repo" action in the GitHub
 * connection section). Detaches any other attached repos and attaches this one,
 * so the chosen repo applies across the whole project.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = AttachRepoRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });
  }

  const res = await setProjectRepo(gate.access.session.userId, gate.access.project.id, parsed.data.repoId);
  if (!res.ok) {
    const status = res.code === "repo_not_found" ? 404 : res.code === "repo_not_yours" ? 403 : 409;
    return NextResponse.json({ ok: false, code: res.code }, { status });
  }

  const repo = await prisma.repo.findUnique({ where: { id: parsed.data.repoId }, select: { fullName: true } });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "repo.attached",
    targetType: "repo",
    targetId: parsed.data.repoId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { action: "set_project_repo", fullName: repo?.fullName },
  });
  await recordActivity({
    projectId: gate.access.project.id,
    actorUserId: gate.access.session.userId,
    action: "attached",
    targetType: "repo",
    targetLabel: repo?.fullName ?? parsed.data.repoId.slice(0, 8),
    icon: "github",
  }).catch(() => {});

  return NextResponse.json({ ok: true, fullName: repo?.fullName ?? null });
}
