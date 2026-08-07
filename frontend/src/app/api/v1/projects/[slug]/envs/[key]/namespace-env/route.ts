import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { showNamespaceEnvTool } from "@/lib/agent/tools/show-namespace-env";
import { audit } from "@/lib/audit/log";
import { requireStepUp, isBrowserRequest } from "@/lib/auth/step-up";

/**
 * GET /projects/[slug]/envs/[key]/namespace-env?namespace=<ns>&nameFilter=<sub>
 *
 * Whole-namespace env dump for the Env Viewer tab. Delegates to the same
 * `show_namespace_env` agent tool the chat surface uses, so the UI and the
 * agent give the user identical answers (same secret-masking, same AAD
 * self-heal on AKS). The response is the tool's Output verbatim on success —
 * the client renders `output.markdown` via <MarkdownText>.
 *
 * `namespace` is REQUIRED (400 otherwise). The client fetches the namespace
 * list via the existing /logs/namespaces endpoint and puts it in a dropdown.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const url = new URL(req.url);
  const reveal = url.searchParams.get("reveal") === "true";

  // Browser-only. This endpoint returns a namespace's whole configuration, so
  // a URL copied out of devtools and replayed in a terminal used to hand over
  // the lot — the cookie rides along automatically. Refuse anything that isn't
  // a same-origin fetch from our own pages, masked view included.
  if (!isBrowserRequest(req)) {
    return NextResponse.json(
      {
        ok: false,
        code: "browser_only",
        message:
          "This endpoint is only callable from the Deep Agent UI. Open the Env viewer instead of replaying the URL.",
      },
      { status: 403 },
    );
  }

  // Reading masked keys is a viewer-level action. Decoding every credential in
  // the namespace is not — that needs write-level trust, so it demands the
  // `developer` role and leaves an audit trail naming who looked.
  const gate = await requireProjectAccess(slug, reveal ? "developer" : "viewer");
  if (!gate.ok) {
    return NextResponse.json(
      {
        ok: false,
        message:
          reveal && gate.status === 403
            ? "Revealing secret values requires the developer role on this project."
            : undefined,
      },
      { status: gate.status },
    );
  }

  // Step-up: the role check above says this user is ALLOWED to see secrets;
  // it says nothing about whether the person holding a 30-day-old cookie is
  // still them. Reveal additionally demands the 6-digit authenticator code —
  // the same one used at login, for the same account.
  if (reveal) {
    const step = await requireStepUp(
      gate.access.session.id,
      req.headers.get("x-reveal-token"),
    );
    if (!step.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "step_up_required",
          message: "Enter your 6-digit authenticator code to reveal secret values.",
        },
        { status: 401 },
      );
    }
  }

  const namespace = url.searchParams.get("namespace")?.trim();
  const nameFilter = url.searchParams.get("nameFilter")?.trim() || undefined;
  if (!namespace) {
    return NextResponse.json(
      { ok: false, code: "missing_namespace", message: "Query param `namespace` is required." },
      { status: 400 },
    );
  }

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) {
    return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
  }

  // The agent reaches tools through executeTool(), which catches throws and
  // hands the model a readable failure. This route calls execute() directly and
  // had no such net, so anything that threw — a stale Prisma client after a
  // schema change, a kubeconfig that won't materialise — surfaced as a bare 500
  // with an empty body and nothing in the UI to act on.
  let result: Awaited<ReturnType<typeof showNamespaceEnvTool.execute>>;
  try {
    result = await showNamespaceEnvTool.execute(
      // `revealSecrets` is intentionally not part of the tool's inputSchema, so
      // the agent can never set it. Passing it here is safe: this call site is
      // behind the developer-role gate above.
      { envKey: key, namespace, nameFilter, revealSecrets: reveal },
      { projectId: gate.access.project.id, userId: gate.access.session.userId },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Reading the namespace failed.";
    console.error(`[namespace-env] ${key}/${namespace} threw:`, e);
    return NextResponse.json({ ok: false, code: "read_failed", message }, { status: 500 });
  }
  if (!result.ok) {
    return NextResponse.json({ ok: false, message: result.error }, { status: 400 });
  }

  if (reveal) {
    await audit({
      userId: gate.access.session.userId,
      projectId: gate.access.project.id,
      action: "env.secrets_revealed",
      targetType: "namespace",
      targetId: `${key}/${namespace}`,
      metadata: { envKey: key, namespace, secretCount: result.output.counts.secrets },
    });
  }

  return NextResponse.json({ ok: true, reveal, ...result.output });
}
