import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveSession } from "@/lib/auth/session";
import { createTeam, listTeamsForUser } from "@/lib/teams/teams";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Team ENTITIES (the actual Team model rows), not the aggregated-collaborators
 * view served by /teams — that path was already in use when Teams landed, so
 * we sit under /teams/entities to keep the namespace tidy without breaking
 * the older consumer.
 */

/** GET /teams/entities — every team the caller belongs to, leads first. */
export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const teams = await listTeamsForUser(sess.userId);
  return NextResponse.json({ teams });
}

const CreateBody = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(500).default(""),
});

/**
 * POST /teams/entities — anyone signed in can create a team; they become its
 * lead. The useful restriction is INSIDE a team (only leads gate projects +
 * invites) rather than on who's allowed to start one.
 */
export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  const team = await createTeam({
    ownerId: sess.userId,
    name: parsed.data.name,
    description: parsed.data.description,
  });

  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "team.created",
    targetType: "team",
    targetId: team.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { slug: team.slug, name: parsed.data.name },
  });

  return NextResponse.json({ ok: true, team });
}
