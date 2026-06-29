import { NextResponse } from "next/server";
import { z } from "zod";
import type { ProjectRole } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { hashPassword } from "@/lib/auth/password";
import { createUser, findUserByEmail } from "@/lib/auth/users";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const Body = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  isSuperAdmin: z.boolean().default(false),
  memberships: z
    .array(
      z.object({
        projectId: z.string().uuid(),
        role: z.enum(["owner", "developer", "viewer"]),
      }),
    )
    .max(50)
    .default([]),
  /** When true, also stamps `emailVerifiedAt` so the user can sign in immediately. */
  preVerified: z.boolean().default(true),
});

/**
 * POST /admin/users/create
 *
 * Super-admin creates an account directly (skipping the email-verification
 * flow if preVerified is set, which is the default). Optionally attaches
 * memberships to one or more projects with any role — including owner.
 *
 * Note that the user's account-level role (`AccountRole.owner`) is the
 * profile-card role and unrelated to platform-admin flag. `isSuperAdmin`
 * grants platform-wide super-admin powers.
 */
export async function POST(req: Request) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const data = parsed.data;

  const existing = await findUserByEmail(data.email);
  if (existing) {
    return NextResponse.json({ ok: false, code: "email_taken" }, { status: 409 });
  }

  const passwordHash = await hashPassword(data.password);
  const user = await createUser({
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email,
    passwordHash,
  });

  // Apply post-create flags + memberships in a single transaction so the
  // user row doesn't appear before its memberships do.
  await prisma.$transaction(async (tx) => {
    if (data.isSuperAdmin || data.preVerified) {
      await tx.user.update({
        where: { id: user.id },
        data: {
          isSuperAdmin: data.isSuperAdmin,
          emailVerifiedAt: data.preVerified ? new Date() : null,
        },
      });
    }
    for (const m of data.memberships) {
      await tx.membership.create({
        data: {
          projectId: m.projectId,
          userId: user.id,
          role: m.role as ProjectRole,
          invitedById: gate.session.userId,
        },
      });
    }
  });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.user_promoted", // covers create + flag set; closest existing AuditAction
    targetType: "user",
    targetId: user.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      email: data.email,
      isSuperAdmin: data.isSuperAdmin,
      memberships: data.memberships.length,
    },
  });

  return NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isSuperAdmin: data.isSuperAdmin,
      memberships: data.memberships.length,
    },
  });
}
