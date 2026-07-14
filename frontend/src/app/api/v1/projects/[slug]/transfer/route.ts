import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { transferProject } from "@/lib/projects/projects";
import { audit } from "@/lib/audit/log";
import { recordActivity } from "@/lib/agentops/activity";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const TransferRequest = z.object({
  newOwnerEmail: z.string().trim().toLowerCase().email(),
  /** Operator confirmation: must equal the project slug. */
  confirmSlug: z.string().trim().min(1),
});

/**
 * Transfer ownership to another user by email. The recipient becomes the
 * project's owner (Project.ownerId + owner membership); the prior owner is
 * demoted to developer so they retain write access but not ownership.
 *
 * Owner-only. The caller must echo the project slug as a confirmation token.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "owner");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = TransferRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: parsed.error.errors[0]?.message,
      },
      { status: 400 },
    );
  }
  if (parsed.data.confirmSlug !== gate.access.project.slug) {
    return NextResponse.json(
      {
        ok: false,
        code: "confirm_mismatch",
        message: `Type the project slug "${gate.access.project.slug}" to confirm.`,
      },
      { status: 400 },
    );
  }

  const res = await transferProject({
    projectId: gate.access.project.id,
    currentOwnerId: gate.access.project.ownerId,
    newOwnerEmail: parsed.data.newOwnerEmail,
  });
  if (!res.ok) {
    const status = res.code === "user_not_found" ? 404 : 409;
    const message =
      res.code === "user_not_found"
        ? "No DeepAgent user with that email."
        : res.code === "already_owner"
          ? "That user already owns this project."
          : "You can't transfer the project to yourself.";
    return NextResponse.json({ ok: false, code: res.code, message }, { status });
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "project.transferred",
    targetType: "project",
    targetId: gate.access.project.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      previousOwnerId: gate.access.project.ownerId,
      newOwnerId: res.newOwner.id,
      newOwnerEmail: res.newOwner.email,
    },
  });
  await recordActivity({
    projectId: gate.access.project.id,
    actorUserId: gate.access.session.userId,
    action: "transferred",
    targetType: "project",
    targetLabel: `${gate.access.project.name} → ${res.newOwner.name}`,
    icon: "users",
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    newOwner: {
      id: res.newOwner.id,
      name: res.newOwner.name,
      email: res.newOwner.email,
    },
  });
}
