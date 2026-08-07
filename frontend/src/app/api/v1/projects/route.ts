import { NextResponse } from "next/server";
import { CreateProjectRequest } from "@/lib/api/schemas/projects-api";
import { getActiveSession } from "@/lib/auth/session";
import { createProject, listProjectsForUser } from "@/lib/projects/projects";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";
import { prisma } from "@/lib/db/prisma";

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  }
  const projects = await listProjectsForUser(sess.userId);
  return NextResponse.json({ projects });
}

export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  }
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateProjectRequest.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: parsed.error.errors[0]?.message ?? "Invalid project details.",
      },
      { status: 400 },
    );
  }
  const { name, description, colorHue, teamSlug } = parsed.data;

  // ADMIN ONLY (2026-08). This app runs as an admin-managed platform: users
  // signed in from an admin-issued account can NOT create projects. The team
  // still owns the project (so members inherit visibility), but only an admin
  // has creation authority. Previous version gated on team-lead role — that
  // was a stepping-stone; the requirement is admin-only.
  if (sess.user.globalAccess !== "admin" && !sess.user.isSuperAdmin) {
    return NextResponse.json(
      {
        ok: false,
        code: "admin_only",
        message: "Only an admin can create projects. Ask your admin.",
      },
      { status: 403 },
    );
  }
  const team = await prisma.team.findUnique({
    where: { slug: teamSlug },
    select: { id: true },
  });
  if (!team) {
    return NextResponse.json(
      { ok: false, code: "team_not_found", message: `Team "${teamSlug}" does not exist.` },
      { status: 404 },
    );
  }

  const project = await createProject({
    ownerId: sess.userId,
    name,
    description,
    colorHue,
    teamId: team.id,
  });
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "project.created",
    targetType: "project",
    targetId: project.id,
    projectId: project.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { slug: project.slug, name },
  });
  return NextResponse.json({ ok: true, project: { id: project.id, slug: project.slug } });
}
