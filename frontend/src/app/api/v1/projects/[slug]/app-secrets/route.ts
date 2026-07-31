import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { applyAppSecret, parseEnvText, findLocalhostValues } from "@/lib/devops/app-secrets";
import { wireSecretToWorkloads, type WireOutcome } from "@/lib/devops/wire-secret-to-workloads";

/**
 * POST /projects/[slug]/app-secrets
 *
 * Write the app's configuration secrets into a namespace and roll the
 * Deployments so running pods pick them up.
 *
 * The counterpart to /aws/rds-connect: that one owns DATABASE_URL, this one
 * owns everything else an app needs to boot (signing keys, API keys, feature
 * flags). Both end the same way — Secret applied, envFrom wired, pods rolled —
 * because a Secret nothing consumes is invisible to the app.
 *
 * The raw text is parsed server-side and never stored anywhere but the
 * cluster Secret.
 */
const Body = z.object({
  envKey: z.string().trim().min(1),
  namespace: z.string().trim().min(1),
  secretName: z
    .string()
    .trim()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "Secret name must be DNS-1123 (lowercase, dashes).")
    .default("app-env"),
  /** `.env`-style text: KEY=value per line. */
  envText: z.string().min(1, "Paste at least one KEY=value line."),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const { entries, skipped } = parseEnvText(body.envText);
  if (entries.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_pairs",
        message:
          "No KEY=value pairs found. Paste .env-style lines, one per line (comments and blanks are ignored).",
      },
      { status: 400 },
    );
  }

  const env = await prisma.env.findFirst({
    where: { projectId: gate.access.project.id, key: body.envKey },
    select: { id: true, cloudProviderId: true },
  });
  if (!env) {
    return NextResponse.json(
      { ok: false, code: "env_not_found", message: `Env "${body.envKey}" not found.` },
      { status: 404 },
    );
  }

  const kcfg = await getKubeconfigForEnv(env.id);
  if (!kcfg.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_cluster",
        message: `${kcfg.message} Connect a Kubernetes cluster to "${body.envKey}" first.`,
      },
      { status: 409 },
    );
  }

  try {
    const execEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);

    const applied = await applyAppSecret({
      kubeconfigPath: kcfg.handle.path,
      execEnv,
      namespace: body.namespace,
      secretName: body.secretName,
      entries,
    });
    if (!applied.ok) {
      return NextResponse.json(
        { ok: false, code: "apply_failed", message: applied.error },
        { status: 409 },
      );
    }

    // Wire + roll. Best-effort: the Secret IS written at this point, so a
    // wiring failure must not present as total failure — it downgrades to
    // "written but not picked up", which the UI states plainly.
    let wired: WireOutcome[] = [];
    let wireError: string | undefined;
    const res = await wireSecretToWorkloads({
      kubeconfigPath: kcfg.handle.path,
      execEnv,
      namespace: body.namespace,
      secretName: body.secretName,
    });
    if (res.ok) wired = res.outcomes;
    else wireError = res.error;

    const patched = wired.filter((w) => w.status === "patched");
    const already = wired.filter((w) => w.status === "already");
    const failed = wired.filter((w) => w.status === "failed");

    return NextResponse.json({
      ok: true,
      secretName: body.secretName,
      namespace: body.namespace,
      keysWritten: applied.keys,
      // Keys whose value points at the developer's machine. These are written
      // as-is (only the caller knows the app's real public address) but MUST be
      // surfaced: a localhost OAuth callback in a cluster produces
      // `oauth_error=missing_nonce`, an error that names neither localhost nor
      // the real cause.
      localhostKeys: findLocalhostValues(entries).map((e) => e.key),
      // Unparseable lines are reported rather than silently dropped — a
      // mangled line usually means a multi-line value, and losing it quietly
      // produces a "why is this key empty" hunt later.
      skippedLines: skipped,
      wired,
      wireError,
      summary:
        failed.length || wireError
          ? `Secret "${body.secretName}" written with ${applied.keys.length} key(s), but wiring did not fully succeed${
              wireError ? ` (${wireError})` : ""
            }.`
          : `Wrote ${applied.keys.length} key(s) to "${body.secretName}" and rolled ${
              patched.length + already.length
            } deployment(s). Pods restart with the new values in ~30s.`,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        code: "unexpected",
        message: e instanceof Error ? e.message : "Unexpected error writing app secrets.",
      },
      { status: 500 },
    );
  } finally {
    await kcfg.handle.cleanup().catch(() => {});
  }
}
