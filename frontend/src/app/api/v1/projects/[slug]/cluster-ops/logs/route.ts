import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getKubernetesLogsTool } from "@/lib/agent/tools/get-kubernetes-logs";

/** Pod logs for the Workloads console. GET ?envKey&podName&namespace&lines */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const sp = new URL(req.url).searchParams;
  const envKey = sp.get("envKey") || "";
  const podName = sp.get("podName") || "";
  const namespace = sp.get("namespace") || undefined;
  const lines = Number(sp.get("lines")) || 200;
  if (!envKey || !podName)
    return NextResponse.json(
      { ok: false, message: "envKey and podName are required." },
      { status: 400 },
    );

  const res = await getKubernetesLogsTool.execute(
    { envKey, podName, namespace, lines },
    { projectId: gate.access.project.id, userId: gate.access.session.userId },
  );
  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
  return NextResponse.json({
    ok: true,
    logs: res.output.logs,
    podName,
    truncated: res.output.truncated,
  });
}
