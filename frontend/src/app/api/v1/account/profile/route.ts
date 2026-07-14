import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";

type ProfileShape = {
  firstName: string;
  lastName: string;
  email: string;
  jobTitle: string;
  timezone: string;
};

function splitName(name: string | null): { firstName: string; lastName: string } {
  if (!name) return { firstName: "", lastName: "" };
  const [first, ...rest] = name.trim().split(/\s+/);
  return { firstName: first ?? "", lastName: rest.join(" ") };
}

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const user = await prisma.user.findUnique({
    where: { id: sess.userId },
    select: {
      email: true,
      name: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      timezone: true,
    },
  });
  if (!user) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  const fallback = splitName(user.name);
  const profile: ProfileShape = {
    firstName: user.firstName ?? fallback.firstName,
    lastName: user.lastName ?? fallback.lastName,
    email: user.email,
    jobTitle: user.jobTitle ?? "",
    timezone: user.timezone ?? "",
  };
  return NextResponse.json(profile);
}

const PatchProfile = z
  .object({
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().max(80).optional(),
    email: z.string().trim().email().optional(),
    jobTitle: z.string().trim().max(120).optional(),
    timezone: z.string().trim().max(64).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });

export async function PATCH(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const parsed = PatchProfile.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_input", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const patch = parsed.data;

  if (patch.email) {
    const taken = await prisma.user.findFirst({
      where: { email: patch.email, NOT: { id: sess.userId } },
      select: { id: true },
    });
    if (taken) {
      return NextResponse.json({ ok: false, code: "email_taken" }, { status: 409 });
    }
  }

  const next: Parameters<typeof prisma.user.update>[0]["data"] = {};
  if (patch.firstName !== undefined) next.firstName = patch.firstName;
  if (patch.lastName !== undefined) next.lastName = patch.lastName;
  if (patch.email !== undefined) next.email = patch.email;
  if (patch.jobTitle !== undefined) next.jobTitle = patch.jobTitle;
  if (patch.timezone !== undefined) next.timezone = patch.timezone;

  // Re-stamp display name when first/last change.
  if (patch.firstName !== undefined || patch.lastName !== undefined) {
    const current = await prisma.user.findUnique({
      where: { id: sess.userId },
      select: { firstName: true, lastName: true, name: true },
    });
    const fb = splitName(current?.name ?? null);
    const first = patch.firstName ?? current?.firstName ?? fb.firstName;
    const last = patch.lastName ?? current?.lastName ?? fb.lastName;
    const composed = `${first} ${last}`.trim();
    if (composed) next.name = composed;
  }

  const updated = await prisma.user.update({
    where: { id: sess.userId },
    data: next,
    select: {
      email: true,
      name: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      timezone: true,
    },
  });
  const fb = splitName(updated.name);
  const profile: ProfileShape = {
    firstName: updated.firstName ?? fb.firstName,
    lastName: updated.lastName ?? fb.lastName,
    email: updated.email,
    jobTitle: updated.jobTitle ?? "",
    timezone: updated.timezone ?? "",
  };
  return NextResponse.json({ ok: true, profile });
}
