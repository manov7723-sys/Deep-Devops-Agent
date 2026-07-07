import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { generateRemediationDoc } from "@/lib/automation/trivy-remediation";
import type { TrivyFinding } from "@/lib/automation/trivy";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/automation/trivy/remediation
 *
 * Turns the findings from a Trivy scan into a developer-facing remediation
 * guide (grouped by severity, every finding with a concrete fix). The findings
 * are sent back from the client (it already has them from the scan) so we don't
 * re-run the scan. The client renders the returned doc to a downloadable PDF.
 */
const Finding = z.object({
  class: z.enum(["vuln", "misconfig", "secret"]),
  target: z.string().default(""),
  targetType: z.string().default(""),
  pkgName: z.string().default(""),
  vulnerabilityId: z.string().default(""),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]),
  status: z.string().default(""),
  installedVersion: z.string().default(""),
  fixedVersion: z.string().default(""),
  location: z.string().default(""),
  title: z.string().default(""),
  description: z.string().default(""),
  resolution: z.string().default(""),
  primaryUrl: z.string().default(""),
});

const Body = z.object({
  artifact: z.string().trim().min(1).max(200),
  findings: z.array(Finding).min(1).max(300),
  counts: z.record(z.string(), z.number()).default({}),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_request", message: "artifact and findings are required." }, { status: 400 });
  }

  const { artifact, findings, counts } = parsed.data;
  const doc = await generateRemediationDoc(artifact, findings as TrivyFinding[], counts);

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "repo.remediation_doc",
    targetType: "repo",
    targetId: artifact,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { automation: "trivy", total: doc.total, aiEnriched: doc.aiEnriched },
  });

  return NextResponse.json({ ok: true, doc });
}
