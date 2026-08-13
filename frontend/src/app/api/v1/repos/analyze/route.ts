import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { decryptSecret } from "@/lib/auth/crypto";
import { analyzeGithubRepo, type Recommendation } from "@/lib/analysis/repo-analyzer";
import { completeText } from "@/lib/agent/agent";

/**
 * POST /repos/analyze — analyze a GitHub repo the CALLER can access.
 *
 * User-scoped (not project-scoped) on purpose: this runs DURING the
 * create-project wizard, before any project exists. Token resolution matches
 * /integrations/github/repos — the caller's own OAuthAccount, optionally
 * pinned to one of several connected identities via accountId.
 *
 * Synchronous: the engine is bounded (1 tree call + ≤ ~20 file reads), which
 * lands well under the route timeout for normal repos. The wizard shows its
 * own progress shimmer while awaiting.
 */
const Body = z.object({
  fullName: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/repo."),
  accountId: z.string().optional(),
  defaultBranch: z.string().trim().max(200).optional(),
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
    return NextResponse.json(
      { ok: false, code: "github_not_connected", message: "Connect GitHub first." },
      { status: 409 },
    );
  }

  const token = decryptSecret(oauth.accessTokenRef);
  const report = await analyzeGithubRepo({
    token,
    fullName: parsed.data.fullName,
    defaultBranch: parsed.data.defaultBranch,
  });

  if ("error" in report) {
    return NextResponse.json({ ok: false, code: "analysis_failed", message: report.error }, { status: 400 });
  }

  // ── Agent review — the in-app agent TESTS the application's deployment
  // readiness on the user's behalf: is the README adequate, do the detected
  // facts hang together, is anything missing for a smooth deploy? Best-effort:
  // no model/key configured → verdict "skipped", heuristics stand alone.
  // The sentinel projectId resolves to the platform-default model (no project
  // exists yet during the wizard).
  if (report.readmeExcerpt) {
    const facts = {
      services: report.services.map((s) => ({ name: s.name, stack: s.stackTitle, role: s.role, port: s.port })),
      infraNeeds: report.infraNeeds.map((n) => `${n.kind} (${n.evidence})`),
      envVarCount: report.envVars.length,
      secretCount: report.envVars.filter((v) => v.secret).length,
      missingFiles: report.missingFiles.map((f) => f.label),
    };
    const review = await completeText({
      projectId: "00000000-0000-0000-0000-000000000000",
      system:
        "You are a senior DevOps reviewer inside a deployment platform. Given a repo README and machine-detected facts, judge whether the application is understood well enough for smooth Kubernetes deployment sizing. Reply with STRICT JSON only, no code fences: " +
        '{"readmeAdequate": true|false, "notes": "2-3 sentences: what the app is, and anything unclear or risky for deployment", "additionalRecommendations": [{"area":"cluster|replicas|resources|database|services|exposure|env","title":"...","value":"...","why":"..."}]}. ' +
        "additionalRecommendations: 0-3 items the heuristics missed (e.g. cron jobs, websockets, GPU, migrations at startup). Empty array when nothing to add.",
      prompt:
        `README (first 6000 chars):\n${report.readmeExcerpt}\n\n` +
        `Detected facts:\n${JSON.stringify(facts, null, 2)}`,
      maxTokens: 700,
    });
    if (review.ok) {
      try {
        const cleaned = review.text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
        const parsed = JSON.parse(cleaned) as {
          readmeAdequate?: boolean;
          notes?: string;
          additionalRecommendations?: Array<Partial<Recommendation>>;
        };
        report.agentReview = {
          verdict: parsed.readmeAdequate === false ? "warn" : "pass",
          notes: (parsed.notes ?? "").slice(0, 600),
        };
        for (const [i, r] of (parsed.additionalRecommendations ?? []).slice(0, 3).entries()) {
          if (r?.title && r?.value) {
            report.recommendations.push({
              id: `agent:${i}`,
              area: (r.area as Recommendation["area"]) ?? "services",
              title: String(r.title).slice(0, 120),
              value: String(r.value).slice(0, 200),
              why: `Agent review: ${String(r.why ?? "").slice(0, 200)}`,
            });
          }
        }
      } catch {
        report.agentReview = { verdict: "skipped", notes: "Agent reply was not parseable — heuristic recommendations stand." };
      }
    } else {
      report.agentReview = { verdict: "skipped", notes: `Agent unavailable (${review.error.slice(0, 120)}) — heuristic recommendations stand.` };
    }
  }

  return NextResponse.json({ ok: true, report });
}
