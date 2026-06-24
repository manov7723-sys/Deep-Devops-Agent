import { NextResponse } from "next/server";
import { CreateProjectRequest } from "@/lib/api/schemas/projects-api";
import { getActiveSession } from "@/lib/auth/session";
import { createProject, listProjectsForUser } from "@/lib/projects/projects";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

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
  const { name, description, colorHue } = parsed.data;
  const project = await createProject({
    ownerId: sess.userId,
    name,
    description,
    colorHue,
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
