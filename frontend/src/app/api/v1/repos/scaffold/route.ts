import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { decryptSecret } from "@/lib/auth/crypto";
import type { RepoAnalysisReport } from "@/lib/analysis/repo-analyzer";
import {
  DOCKERIGNORE,
  dockerfileFor,
  envExampleFor,
} from "@/lib/analysis/scaffold-templates";

/**
 * POST /repos/scaffold — generate ONE missing scaffolding file and commit it
 * to the repo's default branch, DURING the create-project wizard (no project
 * exists yet, so this is user-scoped like /repos/analyze: the caller's own
 * GitHub OAuth token does the commit via the contents API).
 *
 * Create-only by design: the wizard only offers files its analysis found
 * MISSING. If the file appeared meanwhile (race), GitHub returns 422 and we
 * surface "already exists" instead of overwriting anyone's work.
 */
const Body = z.object({
  fullName: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/repo."),
  accountId: z.string().optional(),
  fileId: z.string().min(1).max(200),
  /** The analysis report the wizard already holds — source of stack/env context. */
  report: z.unknown(),
});

export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const { fullName, fileId } = parsed.data;
  const report = parsed.data.report as RepoAnalysisReport;
  if (!report?.services || !report?.missingFiles) {
    return NextResponse.json({ ok: false, code: "invalid_report" }, { status: 400 });
  }

  const missing = report.missingFiles.find((f) => f.id === fileId);
  if (!missing?.generatable) {
    return NextResponse.json({ ok: false, code: "unknown_file" }, { status: 404 });
  }

  // Resolve content + path (same mapping as the in-project generate-file route).
  let path: string;
  let content: string;
  if (fileId.startsWith("dockerfile:")) {
    const svc = report.services.find((s) => (s.path || "root") === (missing.servicePath || "root"));
    if (!svc) return NextResponse.json({ ok: false, code: "unknown_service" }, { status: 404 });
    path = svc.path ? `${svc.path}/Dockerfile` : "Dockerfile";
    content = dockerfileFor(svc);
  } else if (fileId === "dockerignore") {
    path = ".dockerignore";
    content = DOCKERIGNORE;
  } else if (fileId === "env-example") {
    path = ".env.example";
    content = envExampleFor(report.envVars ?? []);
  } else {
    return NextResponse.json({ ok: false, code: "unknown_file" }, { status: 404 });
  }

  // Caller's GitHub token — same resolution as /repos/analyze.
  const oauth = parsed.data.accountId
    ? await prisma.oAuthAccount.findFirst({
        where: { id: parsed.data.accountId, userId: sess.userId, provider: "github" },
        select: { accessTokenRef: true },
      })
    : await prisma.oAuthAccount.findFirst({
        where: { userId: sess.userId, provider: "github" },
        orderBy: { createdAt: "desc" },
        select: { accessTokenRef: true },
      });
  if (!oauth?.accessTokenRef) {
    return NextResponse.json({ ok: false, code: "github_not_connected" }, { status: 409 });
  }
  const token = decryptSecret(oauth.accessTokenRef);

  const res = await fetch(
    `https://api.github.com/repos/${fullName}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `chore: add ${path} (generated from repo analysis)`,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: report.defaultBranch || "main",
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const already = res.status === 422 && /sha.*wasn.t supplied|already exists/i.test(text);
    return NextResponse.json(
      {
        ok: false,
        code: already ? "file_exists" : `github_${res.status}`,
        message: already
          ? `${path} already exists on ${report.defaultBranch} — nothing overwritten.`
          : `GitHub returned ${res.status} committing ${path}.`,
      },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true, path, branch: report.defaultBranch || "main" });
}
