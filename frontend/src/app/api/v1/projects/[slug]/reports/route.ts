import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { discoverDeployedApps } from "@/lib/reports/discover-apps";
import { runProjectReports, localDayKey } from "@/lib/reports/run-reports";
import { resolveMailConfig } from "@/lib/reports/mailer";

/**
 * GET  /projects/[slug]/reports
 *   Everything the Reports tab renders: apps grouped by namespace, each
 *   namespace's recipients, its last send, and whether SMTP is usable at all.
 *   One request rather than three, because the tab is useless until all of it
 *   has arrived.
 *
 * POST /projects/[slug]/reports
 *   { action: "add-recipient" | "remove-recipient" | "toggle-recipient" | "send-now" }
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const projectId = gate.access.project.id;

  const [namespaces, recipients, runs, mail] = await Promise.all([
    discoverDeployedApps(projectId),
    prisma.reportRecipient.findMany({
      where: { projectId },
      select: { id: true, namespace: true, email: true, enabled: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.reportRun.findMany({
      where: { projectId },
      select: { namespace: true, reportDate: true, status: true, detail: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    resolveMailConfig(),
  ]);

  // A namespace can have recipients but no live apps (cluster deleted, app
  // torn down). Those must still appear — otherwise the user can't see or
  // remove the subscription that's generating "namespace not found" reports.
  const known = new Set(namespaces.map((n) => n.namespace));
  const orphaned = [...new Set(recipients.map((r) => r.namespace))].filter((n) => !known.has(n));

  const lastRunByNs = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!lastRunByNs.has(r.namespace)) lastRunByNs.set(r.namespace, r);

  const sections = [
    ...namespaces.map((n) => ({ ...n, orphaned: false })),
    ...orphaned.map((namespace) => ({
      namespace,
      envKey: "",
      envId: "",
      cloud: "unknown" as const,
      clusterReachable: false,
      note: "No cluster in this project currently has this namespace.",
      apps: [],
      orphaned: true,
    })),
  ].map((n) => ({
    ...n,
    recipients: recipients.filter((r) => r.namespace === n.namespace),
    lastRun: lastRunByNs.get(n.namespace) ?? null,
  }));

  return NextResponse.json({
    ok: true,
    reportHour: 10,
    today: localDayKey(new Date()),
    smtp: mail.ok
      ? { configured: true }
      : { configured: false, error: mail.error, missing: mail.missing },
    sections,
  });
}

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add-recipient"),
    namespace: z.string().trim().min(1),
    // Accept a pasted list — users add a team, not one address at a time.
    emails: z.string().trim().min(1),
  }),
  z.object({ action: z.literal("remove-recipient"), id: z.string().uuid() }),
  z.object({ action: z.literal("toggle-recipient"), id: z.string().uuid(), enabled: z.boolean() }),
  z.object({ action: z.literal("send-now"), namespace: z.string().trim().min(1) }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const projectId = gate.access.project.id;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const body = parsed.data;

  if (body.action === "add-recipient") {
    // Split on comma / semicolon / whitespace so a pasted address block works
    // without the user reformatting it.
    const candidates = body.emails
      .split(/[,;\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const valid = candidates.filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    const invalid = candidates.filter((e) => !valid.includes(e));
    if (valid.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          code: "no_valid_emails",
          message: `No valid email addresses found${invalid.length ? ` — rejected: ${invalid.join(", ")}` : ""}.`,
        },
        { status: 400 },
      );
    }
    // createMany + skipDuplicates: re-adding an existing address is a no-op
    // rather than a unique-constraint error the user has to interpret.
    await prisma.reportRecipient.createMany({
      data: valid.map((email) => ({ projectId, namespace: body.namespace, email })),
      skipDuplicates: true,
    });
    return NextResponse.json({ ok: true, added: valid, rejected: invalid });
  }

  if (body.action === "remove-recipient") {
    // Scope the delete to this project so an id from another project can't be
    // removed by guessing.
    const res = await prisma.reportRecipient.deleteMany({ where: { id: body.id, projectId } });
    return NextResponse.json({ ok: res.count > 0, removed: res.count });
  }

  if (body.action === "toggle-recipient") {
    const res = await prisma.reportRecipient.updateMany({
      where: { id: body.id, projectId },
      data: { enabled: body.enabled },
    });
    return NextResponse.json({ ok: res.count > 0 });
  }

  // send-now — same path the scheduler uses, with the daily guard bypassed.
  const results = await runProjectReports({
    projectId,
    now: new Date(),
    onlyNamespace: body.namespace,
    force: true,
  });
  if (results.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_recipients",
        message: `No enabled recipients for "${body.namespace}" — add an address first.`,
      },
      { status: 400 },
    );
  }
  const failed = results.filter((r) => r.status === "failed");
  return NextResponse.json({
    ok: failed.length === 0,
    results,
    message:
      failed.length === 0
        ? `Sent to ${results.flatMap((r) => r.recipients).join(", ")}.`
        : failed.map((f) => f.detail).join(" "),
  });
}
