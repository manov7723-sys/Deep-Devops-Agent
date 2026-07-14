import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { getGcpAccessToken } from "@/lib/cloud/gcp";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const CONTAINER = "https://container.googleapis.com/v1";
const DELETE_POLL_MS = 5_000;
const DELETE_TIMEOUT_MS = 8 * 60_000; // GKE cluster delete typically 3-6 min

const Body = z.object({
  project: z.string().trim().min(1).max(64),
  location: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(60),
});

/**
 * Delete a GKE cluster via the Google Container REST API using the env's
 * stored GCP creds. Fires the DELETE, then polls the returned operation until
 * `status === "DONE"` or timeout. This is what the UI's "Delete existing
 * cluster" button hits when a terraform apply failed with 409 alreadyExists —
 * so the user can wipe the orphan and retry the apply without touching gcloud.
 *
 * Returns 200 with `{ ok: true, deleted: true }` on success, 409 with
 * `{ ok: false, code: "not_found" }` if the cluster wasn't there to begin with,
 * or 504 if the operation is still going when the poll timeout hits (the
 * delete keeps running on Google's side; user can retry to keep polling).
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const { project, location, name } = parsed.data;

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
  if (!env.cloudProviderId) {
    return NextResponse.json(
      { ok: false, code: "no_provider", message: "This env has no cloud provider attached." },
      { status: 409 },
    );
  }

  const cp = await prisma.cloudProvider.findUnique({
    where: { id: env.cloudProviderId },
    select: { kind: true },
  });
  if (cp?.kind !== "gcp") {
    return NextResponse.json(
      {
        ok: false,
        code: "wrong_cloud",
        message: `Env's cloud is ${cp?.kind ?? "unknown"}, not GCP.`,
      },
      { status: 409 },
    );
  }

  const tok = await getGcpAccessToken(env.cloudProviderId);
  if (!tok.ok) {
    return NextResponse.json(
      { ok: false, code: "auth_failed", message: `Could not authenticate to GCP: ${tok.error}` },
      { status: 502 },
    );
  }

  const path = `${CONTAINER}/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/clusters/${encodeURIComponent(name)}`;
  const del = await fetch(path, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${tok.accessToken}` },
    cache: "no-store",
  });

  if (del.status === 404) {
    return NextResponse.json({ ok: true, deleted: false, alreadyGone: true });
  }
  if (!del.ok) {
    const body = await del.text().catch(() => "");
    return NextResponse.json(
      { ok: false, code: "delete_failed", status: del.status, message: body.slice(0, 800) },
      { status: 502 },
    );
  }

  // Response includes `name` and (typically) `selfLink` of the Operation resource.
  const op = (await del.json().catch(() => ({}))) as {
    name?: string;
    selfLink?: string;
    status?: string;
  };
  const operationSelfLink =
    op.selfLink ??
    (op.name
      ? `${CONTAINER}/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/operations/${encodeURIComponent(op.name)}`
      : null);

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "gke.cluster_deleted",
    targetType: "env",
    targetId: env.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { project, location, cluster: name },
  });

  // Poll the operation until DONE or timeout. Google's delete for a small
  // regional GKE cluster typically finishes in 3-6 min.
  if (operationSelfLink) {
    const start = Date.now();
    while (Date.now() - start < DELETE_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, DELETE_POLL_MS));
      const pol = await fetch(operationSelfLink, {
        headers: { Authorization: `Bearer ${tok.accessToken}` },
        cache: "no-store",
      });
      if (!pol.ok) continue; // transient — keep polling until timeout
      const opState = (await pol.json().catch(() => ({}))) as { status?: string; error?: unknown };
      if (opState.status === "DONE") {
        if (opState.error) {
          return NextResponse.json(
            {
              ok: false,
              code: "delete_op_failed",
              message: JSON.stringify(opState.error).slice(0, 800),
            },
            { status: 502 },
          );
        }
        return NextResponse.json({ ok: true, deleted: true });
      }
    }
    return NextResponse.json(
      {
        ok: false,
        code: "timeout",
        message:
          "Delete is still in progress on Google's side. Click again in a couple of minutes to keep polling, or check the GCP console.",
      },
      { status: 504 },
    );
  }

  // No operation link (unusual) — assume async; caller can retry / verify.
  return NextResponse.json({ ok: true, deleted: true, unpolled: true });
}
