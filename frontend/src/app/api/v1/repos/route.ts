import { NextResponse } from "next/server";
import { CreateRepoRequest } from "@/lib/api/schemas/connectivity-api";
import { getActiveSession } from "@/lib/auth/session";
import { createRepo, listReposForUser } from "@/lib/repos/repos";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/** Bare array — `useRepos()` iterates `.map` directly (no envelope). */
export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const repos = await listReposForUser(sess.userId);
  return NextResponse.json(repos);
}

export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const parsed = CreateRepoRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: parsed.error.errors[0]?.message ?? "Invalid repo details.",
      },
      { status: 400 },
    );
  }
  const res = await createRepo({ ownerId: sess.userId, ...parsed.data });
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, code: res.code, message: "This repo is already connected." },
      { status: 409 },
    );
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "repo.connected",
    targetType: "repo",
    targetId: res.repo.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fullName: res.repo.fullName },
  });
  return NextResponse.json({ ok: true, repo: res.repo });
}
