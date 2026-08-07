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

  // Only a TEAM LEAD can create projects under a team. Members can't, non-
  // members obviously can't. Enforced here so the UI can offer a plain slug
  // picker without shipping every user's role in the client.
  const team = await prisma.team.findUnique({
    where: { slug: teamSlug },
    select: {
      id: true,
      memberships: { where: { userId: sess.userId }, select: { role: true } },
    },
  });
  if (!team) {
    return NextResponse.json(
      { ok: false, code: "team_not_found", message: `Team "${teamSlug}" does not exist.` },
      { status: 404 },
    );
  }
  const m = team.memberships[0];
  if (!m || m.role !== "lead") {
    return NextResponse.json(
      {
        ok: false,
        code: "not_team_lead",
        message: !m
          ? `You are not a member of "${teamSlug}". Ask a lead to invite you before creating projects here.`
          : `Only a team LEAD can create projects under "${teamSlug}". Ask a lead of this team.`,
      },
      { status: 403 },
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
