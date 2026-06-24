import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { createInvitation } from "@/lib/projects/invitations";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const ROLE_RANK = { owner: 3, developer: 2, viewer: 1 } as const;

/**
 * GET /teams — collaborators across every project you can see.
 *
 * Aggregated from Membership: any user who shares one or more projects with
 * you. Their effective role is the MAX role they hold in any of those shared
 * projects (so an "owner" on one project + "viewer" on another shows as owner).
 */
export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const myProjects = await prisma.membership.findMany({
    where: { userId: sess.userId },
    select: { projectId: true, role: true },
  });
  const projectIds = myProjects.map((m) => m.projectId);
  if (projectIds.length === 0) return NextResponse.json([]);
  const myRoleByProject = new Map(myProjects.map((m) => [m.projectId, m.role]));

  const all = await prisma.membership.findMany({
    where: { projectId: { in: projectIds }, NOT: { userId: sess.userId } },
    select: {
      role: true,
      joinedAt: true,
      project: { select: { id: true, slug: true, name: true } },
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          sessions: {
            orderBy: { lastSeenAt: "desc" },
            take: 1,
            select: { lastSeenAt: true },
          },
        },
      },
    },
  });

  type SharedProject = {
    id: string;
    slug: string;
    name: string;
    memberRole: "owner" | "developer" | "viewer";
    /** Caller's own role in this shared project — controls whether the Remove
     *  affordance lights up for this row. */
    myRole: "owner" | "developer" | "viewer";
  };
  type Agg = {
    id: string;
    name: string;
    email: string;
    role: "owner" | "developer" | "viewer";
    projects: number;
    sharedProjects: SharedProject[];
    lastSeenAt: Date | null;
    earliestJoinedAt: Date;
  };
  const byUser = new Map<string, Agg>();
  for (const m of all) {
    const shared: SharedProject = {
      id: m.project.id,
      slug: m.project.slug,
      name: m.project.name,
      memberRole: m.role,
      myRole: myRoleByProject.get(m.project.id) ?? "viewer",
    };
    const prev = byUser.get(m.user.id);
    const lastSeen = m.user.sessions[0]?.lastSeenAt ?? null;
    if (!prev) {
      byUser.set(m.user.id, {
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
        projects: 1,
        sharedProjects: [shared],
        lastSeenAt: lastSeen,
        earliestJoinedAt: m.joinedAt,
      });
    } else {
      prev.projects += 1;
      prev.sharedProjects.push(shared);
      if (ROLE_RANK[m.role] > ROLE_RANK[prev.role]) prev.role = m.role;
      if (m.joinedAt < prev.earliestJoinedAt) prev.earliestJoinedAt = m.joinedAt;
      if (lastSeen && (!prev.lastSeenAt || lastSeen > prev.lastSeenAt)) prev.lastSeenAt = lastSeen;
    }
  }

  const items = [...byUser.values()].map((a) => ({
    id: a.id,
    name: a.name,
    email: a.email,
    role: a.role,
    projects: a.projects,
    sharedProjects: a.sharedProjects,
    lastActive: humanizeRelative(a.lastSeenAt),
    invitedAt: a.earliestJoinedAt.toISOString(),
    joinedAt: a.earliestJoinedAt.toISOString(),
  }));
  items.sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json(items);
}

const PostBody = z.object({
  email: z.string().trim().email(),
  // "owner" is intentionally excluded — owners are the project creators
  // and can't be invited in; use transfer-ownership for that.
  role: z.enum(["developer", "viewer"]).default("developer"),
  projectIds: z.array(z.string().uuid()).min(1, "Pick at least one project"),
});

/**
 * POST /teams — invite a collaborator to one or more projects.
 *
 * The caller must be an owner of every project they're inviting to. Each
 * invitation goes through createInvitation (mints magic link, sends email,
 * upserts ProjectInvitation row).
 */
export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  }
  const { email, role, projectIds } = parsed.data;

  // Caller must be owner of every target project.
  const myOwners = await prisma.membership.findMany({
    where: { userId: sess.userId, projectId: { in: projectIds }, role: "owner" },
    select: { projectId: true },
  });
  const ownedSet = new Set(myOwners.map((m) => m.projectId));
  const notOwned = projectIds.filter((id) => !ownedSet.has(id));
  if (notOwned.length > 0) {
    return NextResponse.json(
      { ok: false, code: "forbidden", message: "You must be an owner of every project you invite to." },
      { status: 403 },
    );
  }

  // Look up project + inviter details once (need name+slug for invitation, name for the email).
  const [projects, inviter] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, name: true, slug: true },
    }),
    prisma.user.findUnique({ where: { id: sess.userId }, select: { name: true } }),
  ]);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const origin = new URL(req.url).origin;

  const meta = extractRequestMeta(req);
  const results: Array<{ projectId: string; ok: boolean; code?: string }> = [];
  for (const projectId of projectIds) {
    const proj = projectById.get(projectId);
    if (!proj) {
      results.push({ projectId, ok: false, code: "project_not_found" });
      continue;
    }
    const r = await createInvitation({
      projectId,
      projectName: proj.name,
      projectSlug: proj.slug,
      email,
      role,
      invitedById: sess.userId,
      inviterName: inviter?.name ?? "A teammate",
      origin,
      requestedIp: meta.ipAddress,
    });
    results.push({ projectId, ok: r.ok, code: r.ok ? undefined : r.code });
  }

  const okCount = results.filter((r) => r.ok).length;
  return NextResponse.json({
    ok: okCount > 0,
    member: {
      email,
      role,
      projects: okCount,
      invitedTo: results,
    },
  });
}

function humanizeRelative(d: Date | null): string {
  if (!d) return "Never";
  const ms = Date.now() - d.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} seconds ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
