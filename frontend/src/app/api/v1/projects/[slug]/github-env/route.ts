import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import {
  listEnvActionsSecrets,
  listEnvActionsVariables,
  listRepoActionsSecrets,
  listRepoActionsVariables,
} from "@/lib/github/secrets";

/**
 * GitHub-sourced app env, and which SERVICE each value belongs to.
 *
 * GET  → the pool of names stored in GitHub (environment-level, plus
 *        repo-level as a fallback) + the services detected for this project
 *        + the current assignment. Secret VALUES are never returned; GitHub
 *        doesn't expose them and the UI only needs names.
 * POST → save the assignment: { [name]: "<service>" | "" }, "" = shared by
 *        every service. Stored on the DeploymentPlan so deploy_my_app can
 *        generate a CD step that routes each value to the right Secret
 *        WITHOUT the user hand-typing `SERVICE__` prefixes in GitHub.
 */
const ASSIGN_KEY = "__envAssign";

async function repoAndToken(projectId: string, repoFullName?: string) {
  const plan = await prisma.deploymentPlan.findUnique({
    where: { projectId },
    select: { repoFullName: true, plan: true },
  });
  const repo = await prisma.repo.findFirst({
    where: {
      deletedAt: null,
      projectRepos: { some: { projectId } },
      ...(repoFullName ? { fullName: repoFullName } : plan?.repoFullName ? { fullName: plan.repoFullName } : {}),
    },
    select: { id: true, fullName: true },
  });
  if (!repo) return { ok: false as const, error: "No GitHub repo attached to this project." };
  const tok = await resolveTokenForRepo(repo.id);
  if (!tok.ok) return { ok: false as const, error: tok.message };
  return { ok: true as const, repo, token: tok.accessToken, plan };
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const url = new URL(req.url);
  const envKey = (url.searchParams.get("envKey") ?? "prod").trim();
  const r = await repoAndToken(gate.access.project.id, url.searchParams.get("repo") ?? undefined);
  if (!r.ok) return NextResponse.json({ ok: false, message: r.error }, { status: 409 });

  const [envSecrets, envVars, repoSecrets, repoVars] = await Promise.all([
    listEnvActionsSecrets(r.token, r.repo.fullName, envKey),
    listEnvActionsVariables(r.token, r.repo.fullName, envKey),
    listRepoActionsSecrets(r.token, r.repo.fullName),
    listRepoActionsVariables(r.token, r.repo.fullName),
  ]);

  type Row = { name: string; kind: "secret" | "variable"; scope: "environment" | "repository" };
  const byName = new Map<string, Row>();
  // Environment-level wins over repo-level: that's GitHub's own precedence.
  for (const n of repoSecrets.ok ? repoSecrets.names : [])
    byName.set(n, { name: n, kind: "secret", scope: "repository" });
  for (const v of repoVars.ok ? repoVars.vars : [])
    byName.set(v.name, { name: v.name, kind: "variable", scope: "repository" });
  for (const n of envSecrets.ok ? envSecrets.names : [])
    byName.set(n, { name: n, kind: "secret", scope: "environment" });
  for (const v of envVars.ok ? envVars.vars : [])
    byName.set(v.name, { name: v.name, kind: "variable", scope: "environment" });

  const report = (r.plan?.plan as { report?: { services?: { name: string; role: string }[] } } | null)
    ?.report;
  const services = (report?.services ?? []).map((s) => ({ name: s.name, role: s.role }));
  const items = ((r.plan?.plan as { items?: Record<string, string> } | null)?.items ?? {}) as Record<
    string,
    string
  >;
  let assignment: Record<string, string> = {};
  try {
    assignment = items[ASSIGN_KEY] ? (JSON.parse(items[ASSIGN_KEY]) as Record<string, string>) : {};
  } catch {
    assignment = {};
  }

  const warnings = [envSecrets, envVars, repoSecrets, repoVars]
    .filter((x): x is { ok: false; error: string } => !x.ok)
    .map((x) => x.error);

  return NextResponse.json({
    ok: true,
    repoFullName: r.repo.fullName,
    envKey,
    services,
    // Sorted so the UI list is stable between polls.
    vars: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    assignment,
    ...(warnings.length ? { warnings } : {}),
  });
}

const PostBody = z.object({
  /** name → service name, or "" for shared across every service. */
  assignment: z.record(z.string()),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });
  }

  const plan = await prisma.deploymentPlan.findUnique({
    where: { projectId: gate.access.project.id },
    select: { plan: true },
  });
  if (!plan) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_plan",
        message: "This project has no analysis yet — run the repo analysis before assigning env vars.",
      },
      { status: 409 },
    );
  }

  const planObj = (plan.plan ?? {}) as { items?: Record<string, string>; report?: unknown };
  const items = { ...(planObj.items ?? {}), [ASSIGN_KEY]: JSON.stringify(parsed.data.assignment) };
  await prisma.deploymentPlan.update({
    where: { projectId: gate.access.project.id },
    data: { plan: { ...planObj, items } as Prisma.InputJsonValue },
  });

  const counts = Object.values(parsed.data.assignment).reduce<Record<string, number>>((acc, svc) => {
    const k = svc || "(shared)";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  return NextResponse.json({
    ok: true,
    saved: Object.keys(parsed.data.assignment).length,
    counts,
    message:
      "Assignment saved. The next deploy routes each value into that service's app-env Secret — no SERVICE__ prefixes needed in GitHub.",
  });
}
