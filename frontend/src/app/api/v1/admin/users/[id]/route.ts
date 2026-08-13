import { NextResponse } from "next/server";
import type { ProjectRole } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { PatchAdminUserRequest } from "@/lib/api/schemas/admin-api";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { setSuperAdmin } from "@/lib/admin/aggregates";
import { hashPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * GET /admin/users/[id]
 *
 * Returns the user's edit-form shape: identity fields + globalAccess flag +
 * the full per-project membership list. Used by the "Edit user" modal to
 * prefill the current state so the admin can toggle from that baseline.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const { id } = await ctx.params;

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      firstName: true,
      lastName: true,
      isSuperAdmin: true,
      globalAccess: true,
      memberships: { select: { projectId: true, role: true } },
    },
  });
  if (!user) {
    return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? user.name.split(" ")[0] ?? "",
      lastName: user.lastName ?? user.name.split(" ").slice(1).join(" ") ?? "",
      name: user.name,
      isSuperAdmin: user.isSuperAdmin,
      globalAccess: user.globalAccess,
      memberships: user.memberships,
    },
  });
}

/**
 * PATCH /admin/users/[id]
 *
 * Partial update. Any field the admin didn't send is left alone.
 *
 *   - firstName / lastName: renames the user; `name` is recomputed.
 *   - globalAccess: sets the platform-wide access tier. Picking `admin`
 *     also flips isSuperAdmin true; picking anything else does NOT
 *     touch isSuperAdmin — call sites can send it explicitly if they
 *     want the two out of lockstep.
 *   - isSuperAdmin: kept for backward compat with older callers that
 *     only flip this bit. Uses setSuperAdmin() so last-admin protections
 *     still apply.
 *   - memberships: WHOLESALE replacement of the user's project
 *     memberships. Rows in the payload become the new set; anything
 *     omitted is deleted. Sent as `undefined` to skip.
 *   - newPassword: rotates the password. Admin communicates the new
 *     value out-of-band; we don't return it.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const { id } = await ctx.params;

  const parsed = PatchAdminUserRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const data = parsed.data;

  const existing = await prisma.user.findUnique({
    where: { id },
    select: { id: true, firstName: true, lastName: true, isSuperAdmin: true },
  });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  }

  // isSuperAdmin transitions go through setSuperAdmin() so last-admin +
  // self-demote guards still fire. Picking globalAccess="admin" implies
  // super-admin true; picking any other tier does NOT auto-flip it off —
  // the admin has to opt in explicitly, so we don't accidentally demote
  // someone by editing their name.
  const wantsSuperAdmin =
    data.isSuperAdmin !== undefined
      ? data.isSuperAdmin
      : data.globalAccess === "admin"
        ? true
        : undefined;

  if (wantsSuperAdmin !== undefined && wantsSuperAdmin !== existing.isSuperAdmin) {
    const res = await setSuperAdmin({ userId: gate.session.userId }, id, wantsSuperAdmin);
    if (!res.ok) {
      const status =
        res.code === "not_found"
          ? 404
          : res.code === "self_demote" || res.code === "last_admin_demote"
            ? 409
            : 400;
      return NextResponse.json({ ok: false, code: res.code }, { status });
    }
  }

  // Everything else in one transaction so we don't leave the user in a
  // half-updated state if e.g. membership creation fails.
  await prisma.$transaction(async (tx) => {
    const userUpdate: Record<string, unknown> = {};
    if (data.firstName !== undefined) userUpdate.firstName = data.firstName;
    if (data.lastName !== undefined) userUpdate.lastName = data.lastName;
    if (data.firstName !== undefined || data.lastName !== undefined) {
      const first = data.firstName ?? existing.firstName ?? "";
      const last = data.lastName ?? existing.lastName ?? "";
      userUpdate.name = `${first} ${last}`.trim();
    }
    if (data.globalAccess !== undefined) userUpdate.globalAccess = data.globalAccess;
    if (data.newPassword !== undefined) {
      userUpdate.passwordHash = await hashPassword(data.newPassword);
      userUpdate.lastPasswordChangedAt = new Date();
    }
    if (Object.keys(userUpdate).length > 0) {
      await tx.user.update({ where: { id }, data: userUpdate });
    }

    if (data.memberships !== undefined) {
      // Whole-set replace: diff what exists so we only churn rows that
      // actually changed. That keeps invitedById / joinedAt stable for
      // memberships the admin didn't touch.
      const current = await tx.membership.findMany({
        where: { userId: id },
        select: { projectId: true, role: true },
      });
      const currentById = new Map(current.map((m) => [m.projectId, m.role as ProjectRole]));
      const nextById = new Map(data.memberships.map((m) => [m.projectId, m.role as ProjectRole]));

      const toDelete = current.filter((m) => !nextById.has(m.projectId));
      const toCreate = data.memberships.filter((m) => !currentById.has(m.projectId));
      const toUpdate = data.memberships.filter(
        (m) => currentById.has(m.projectId) && currentById.get(m.projectId) !== m.role,
      );

      if (toDelete.length > 0) {
        await tx.membership.deleteMany({
          where: {
            userId: id,
            projectId: { in: toDelete.map((m) => m.projectId) },
          },
        });
      }
      for (const m of toCreate) {
        await tx.membership.create({
          data: {
            projectId: m.projectId,
            userId: id,
            role: m.role as ProjectRole,
            invitedById: gate.session.userId,
          },
        });
      }
      for (const m of toUpdate) {
        await tx.membership.update({
          where: { projectId_userId: { projectId: m.projectId, userId: id } },
          data: { role: m.role as ProjectRole },
        });
      }
    }
  });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.user_promoted", // closest existing AuditAction; covers edit + tier changes
    targetType: "user",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      fields: Object.keys(data),
      passwordReset: data.newPassword !== undefined,
    },
  });

  return NextResponse.json({ ok: true });
}
