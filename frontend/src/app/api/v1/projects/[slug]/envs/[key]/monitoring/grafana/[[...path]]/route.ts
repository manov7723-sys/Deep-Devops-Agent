import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { getGrafanaForwardBase } from "@/lib/observability/kube-proxy";

export const dynamic = "force-dynamic";

/**
 * Reverse proxy for the env's in-cluster Grafana.
 *
 * Browser → this route → authenticated `kubectl port-forward` (127.0.0.1) →
 * Grafana pod (direct TCP tunnel, no API-server service-proxy → no injected
 * X-Forwarded-Prefix). Grafana is installed with serve_from_sub_path + root_url
 * pointing at THIS path, so it emits asset/API URLs under /…/monitoring/grafana/…
 * and everything resolves back through here. Nothing is exposed publicly; access
 * is gated by project membership.
 */
async function handle(
  req: Request,
  ctx: { params: Promise<{ slug: string; key: string; path?: string[] }> },
): Promise<Response> {
  const { slug, key, path } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return new Response("Forbidden", { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return new Response("Environment not found", { status: 404 });

  let base: string;
  try {
    base = await getGrafanaForwardBase(env.id);
  } catch (e) {
    return new Response(`Grafana tunnel unavailable: ${e instanceof Error ? e.message : "error"}`, { status: 502 });
  }

  // Forward straight to Grafana over the tunnel, keeping the full app sub-path so
  // serve_from_sub_path matches. No API-server proxy prefix involved.
  const rest = (path ?? []).join("/");
  const search = new URL(req.url).search;
  const rootPath = `/api/v1/projects/${slug}/envs/${key}/monitoring/grafana`;
  const target = `${base}${rootPath}/${rest}${search}`;

  // Forward request headers, minus ones that must not be relayed.
  const fwdHeaders = new Headers(req.headers);
  for (const h of ["host", "connection", "accept-encoding", "content-length"]) fwdHeaders.delete(h);

  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers: fwdHeaders, body, redirect: "manual" });
  } catch (e) {
    return new Response(`Grafana unreachable: ${e instanceof Error ? e.message : "error"}`, { status: 502 });
  }

  // Relay status + body, stripping hop-by-hop / encoding headers we can't honor.
  const resHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (["connection", "transfer-encoding", "content-encoding", "content-length", "set-cookie"].includes(k.toLowerCase())) return;
    resHeaders.set(k, v);
  });
  for (const c of upstream.headers.getSetCookie?.() ?? []) resHeaders.append("set-cookie", c);

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: resHeaders });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
