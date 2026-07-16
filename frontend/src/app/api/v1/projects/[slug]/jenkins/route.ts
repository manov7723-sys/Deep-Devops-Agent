import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { encryptSecret } from "@/lib/auth/crypto";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { verifyJenkins } from "@/lib/ci/jenkins/client";

/**
 * Per-project Jenkins connection.
 *
 *   GET    → connected: boolean, url/username (never the token) + last verify state
 *   POST   → connect + verify (rejects if creds don't authenticate)
 *   DELETE → clear the stored connection
 *
 * The URL and username are stored plain (non-sensitive); the API token is
 * encrypted at rest via AES-256-GCM (encryptSecret) — same key domain as
 * every other AppSecret in the project.
 */

const ConnectBody = z.object({
  url: z.string().trim().url().refine((u) => u.startsWith("http"), "URL must start with http/https"),
  username: z.string().trim().min(1),
  apiToken: z.string().trim().min(1),
});

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const rows = await prisma.appSecret.findMany({
    where: {
      projectId: gate.access.project.id,
      key: { in: ["jenkins_url", "jenkins_username"] },
    },
    select: { key: true, valueRef: true, updatedAt: true },
  });
  const url = rows.find((r) => r.key === "jenkins_url");
  const username = rows.find((r) => r.key === "jenkins_username");
  const tokenRow = await prisma.appSecret.findFirst({
    where: { projectId: gate.access.project.id, key: "jenkins_token" },
    select: { updatedAt: true },
  });
  return NextResponse.json({
    ok: true,
    connected: !!(url && username && tokenRow),
    url: url?.valueRef ?? null,
    username: username?.valueRef ?? null,
    connectedAt: tokenRow?.updatedAt ?? null,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = ConnectBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const { url, username, apiToken } = parsed.data;

  // Verify BEFORE persisting — a rejected token is a user error, not a
  // silent-broken connection to debug later.
  const trimmedUrl = url.replace(/\/+$/, "");
  const verify = await verifyJenkins({ baseUrl: trimmedUrl, username, apiToken });
  if (!verify.ok) {
    return NextResponse.json(
      { ok: false, code: "verify_failed", message: verify.error },
      { status: 400 },
    );
  }

  // Upsert the 3 rows in one transaction so a partial write can't leave the
  // connection half-configured.
  await prisma.$transaction([
    prisma.appSecret.upsert({
      where: { projectId_key: { projectId: gate.access.project.id, key: "jenkins_url" } },
      create: { projectId: gate.access.project.id, key: "jenkins_url", valueRef: trimmedUrl },
      update: { valueRef: trimmedUrl },
    }),
    prisma.appSecret.upsert({
      where: { projectId_key: { projectId: gate.access.project.id, key: "jenkins_username" } },
      create: { projectId: gate.access.project.id, key: "jenkins_username", valueRef: username },
      update: { valueRef: username },
    }),
    prisma.appSecret.upsert({
      where: { projectId_key: { projectId: gate.access.project.id, key: "jenkins_token" } },
      create: {
        projectId: gate.access.project.id,
        key: "jenkins_token",
        valueRef: encryptSecret(apiToken),
      },
      update: { valueRef: encryptSecret(apiToken) },
    }),
  ]);

  return NextResponse.json({ ok: true, connectedAs: verify.user, url: trimmedUrl });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  await prisma.appSecret.deleteMany({
    where: {
      projectId: gate.access.project.id,
      key: { in: ["jenkins_url", "jenkins_username", "jenkins_token"] },
    },
  });
  return NextResponse.json({ ok: true });
}
