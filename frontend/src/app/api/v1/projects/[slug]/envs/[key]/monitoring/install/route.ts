import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { beginInstallMonitoring } from "@/lib/observability/cluster-monitoring";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/envs/[key]/monitoring/install
 *
 * Model B — the app installs kube-prometheus-stack (Prometheus + Grafana +
 * exporters) INTO the env's connected cluster via Helm. The user clicks one
 * button; nothing runs outside the app and nothing is exposed publicly. The
 * stack is then queried through the cluster connection (API-server proxy).
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });

  // Public URL of THIS app's Grafana proxy route — baked into Grafana's root_url
  // at install so it serves correctly behind the kube API-server proxy + iframe.
  // Protocol: trust x-forwarded-proto (behind a real proxy), else fall back to
  // the request's own protocol — NOT a blind "https", which breaks asset loading
  // on http://localhost (Grafana would try to fetch its JS over https → fail).
  const reqUrl = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? reqUrl.protocol.replace(":", "") ?? "http";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? reqUrl.host;
  const grafanaRootUrl = `${proto}://${host}/api/v1/projects/${slug}/envs/${key}/monitoring/grafana/`;

  // Kick off the install in the background and return immediately — helm can
  // take minutes (and may run stuck-release recovery first). The client polls
  // the status endpoint, which reports progress + any install error.
  const { alreadyRunning } = beginInstallMonitoring(env.id, { grafanaRootUrl });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "monitoring.installed",
    targetType: "env",
    targetId: key,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { stack: "kube-prometheus-stack", via: "model_b" },
  });

  return NextResponse.json({
    ok: true,
    message: alreadyRunning
      ? "Install already in progress…"
      : "Installing — Prometheus + Grafana are being deployed. This takes a few minutes.",
  });
}
