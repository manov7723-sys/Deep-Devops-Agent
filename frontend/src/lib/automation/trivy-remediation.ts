/**
 * AI remediation documentation for a Trivy scan.
 *
 * Takes the findings from a scan and produces a developer-facing remediation
 * guide grouped by severity (CRITICAL → HIGH → MEDIUM → LOW), where every
 * finding carries a concrete "what to change" recommendation. A DevOps person
 * generates this, downloads it as a PDF (rendered client-side), and shares it
 * with the developers who own the code.
 *
 * Design: the recommendations are built DETERMINISTICALLY from the Trivy data
 * (upgrade-to-fixed-version, rotate-secret, fix-misconfig) so the document is
 * always useful — even when no LLM is reachable. When ANTHROPIC_API_KEY is set
 * and valid, Claude ENRICHES it with an executive summary, per-severity
 * guidance, and sharper per-finding advice. If the LLM call fails we silently
 * fall back to the deterministic doc (aiEnriched: false).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { TrivyFinding, Severity, FindingClass } from "./trivy";

const MODEL = process.env.DDA_ANALYSIS_MODEL || "claude-sonnet-4-5";
const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];
const MAX_AI_ITEMS = 80; // bound the prompt; the rest keep deterministic advice

export type RemediationItem = {
  id: string;
  cls: FindingClass;
  where: string; // target (+ line for misconfig/secret)
  pkg: string;
  installed: string;
  fixedVersion: string;
  title: string;
  description: string; // Trivy's explanation of what's wrong (misconfig)
  resolution: string; // Trivy's own suggested fix (misconfig)
  recommendation: string; // the concrete change a developer should make
};

export type RemediationSection = {
  severity: Severity;
  overview: string;
  items: RemediationItem[];
};

export type RemediationDoc = {
  artifact: string;
  summary: string;
  counts: Record<string, number>;
  total: number;
  sections: RemediationSection[];
  aiEnriched: boolean;
};

function whereOf(f: TrivyFinding): string {
  const loc = f.location ? ` (${f.location})` : "";
  return `${f.target || "—"}${loc}`;
}

/**
 * Concrete, code-level fixes for the most common IaC rules. Trivy ships a
 * `Resolution` for most rules, but for the ones users hit most we give the exact
 * change so the doc is unambiguous even with no LLM. Keyed by AVD/rule id.
 */
const KNOWN_FIX: Record<string, string> = {
  "AVD-AWS-0040":
    "In the EKS cluster's `vpc_config`, set `endpoint_public_access = false` and keep `endpoint_private_access = true`, so the Kubernetes API server is reachable only from inside the VPC, not the public internet.",
  "AVD-AWS-0041":
    "In the EKS cluster's `vpc_config`, replace `public_access_cidrs = [\"0.0.0.0/0\"]` with the specific admin/CI IP ranges that actually need API access — never leave it open to the whole internet.",
};
// Trivy reports the same rule under both `AVD-AWS-0040` and the short `AWS-0040`.
function knownFixFor(id: string): string | undefined {
  if (!id) return undefined;
  return KNOWN_FIX[id] ?? KNOWN_FIX[`AVD-${id}`];
}

/** The baseline "what to change", derived purely from the finding's own data. */
function deterministicFix(f: TrivyFinding): string {
  if (f.class === "secret") {
    return `Remove the hardcoded secret at ${whereOf(f)}, rotate the exposed credential immediately, and load it at runtime from a secret manager or environment variable instead of committing it.`;
  }
  if (f.class === "misconfig") {
    const known = knownFixFor(f.vulnerabilityId);
    if (known) return `${known} (at ${whereOf(f)}).`;
    if (f.resolution) {
      const why = f.description ? ` Why it's flagged: ${f.description}` : "";
      return `${f.resolution.replace(/\.$/, "")} — apply at ${whereOf(f)}.${why}`;
    }
    return `Fix “${f.title || f.vulnerabilityId}” at ${whereOf(f)}${f.description ? `: ${f.description}` : " by following the linked advisory."}`;
  }
  // vuln
  if (f.fixedVersion) {
    const from = f.installedVersion ? `from ${f.installedVersion} ` : "";
    return `Upgrade ${f.pkgName || "the affected package"} ${from}to ${f.fixedVersion} or later, then re-run the scan to confirm ${f.vulnerabilityId || "the issue"} is resolved.`;
  }
  return `No fixed version is published yet for ${f.pkgName || "this package"}. Track advisory ${f.vulnerabilityId || "(see source)"}, apply the documented workaround, or replace the dependency until a patched release is available.`;
}

const SEVERITY_OVERVIEW: Record<Severity, string> = {
  CRITICAL: "Critical issues can lead to full compromise (remote code execution, credential theft). Treat these as drop-everything work — patch or mitigate before the next release.",
  HIGH: "High-severity issues are readily exploitable and should be fixed in the current sprint.",
  MEDIUM: "Medium-severity issues are worth scheduling soon; they raise risk but usually need specific conditions to exploit.",
  LOW: "Low-severity issues are minor or hard to exploit. Batch them into routine maintenance.",
  UNKNOWN: "Severity could not be determined automatically. Review each item and assign a priority.",
};

/** Build the deterministic skeleton (always correct, no LLM needed). */
function buildSkeleton(artifact: string, findings: TrivyFinding[], counts: Record<string, number>): RemediationDoc {
  const bySeverity = new Map<Severity, RemediationItem[]>();
  for (const f of findings) {
    const sev = (SEVERITY_ORDER.includes(f.severity) ? f.severity : "UNKNOWN") as Severity;
    const item: RemediationItem = {
      id: f.vulnerabilityId || "(no id)",
      cls: f.class,
      where: whereOf(f),
      pkg: f.pkgName || "",
      installed: f.installedVersion || "",
      fixedVersion: f.fixedVersion || "",
      title: f.title || "",
      description: f.description || "",
      resolution: f.resolution || "",
      recommendation: deterministicFix(f),
    };
    const arr = bySeverity.get(sev) ?? [];
    arr.push(item);
    bySeverity.set(sev, arr);
  }

  const sections: RemediationSection[] = SEVERITY_ORDER.filter((s) => (bySeverity.get(s)?.length ?? 0) > 0).map((s) => ({
    severity: s,
    overview: SEVERITY_OVERVIEW[s],
    items: bySeverity.get(s)!,
  }));

  const total = findings.length;
  const lead = SEVERITY_ORDER.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s.toLowerCase()}`).join(", ");
  const summary =
    total === 0
      ? `No vulnerabilities were found in ${artifact}.`
      : `Trivy found ${total} issue${total === 1 ? "" : "s"} in ${artifact} (${lead}). Work through them in severity order — each item below lists the exact change to make.`;

  return { artifact, summary, counts, total, sections, aiEnriched: false };
}

type AiPayload = {
  summary?: string;
  sections?: Array<{ severity?: string; overview?: string }>;
  items?: Array<{ id?: string; recommendation?: string }>;
};

/** Ask Claude to enrich the skeleton. Returns null on any failure (we fall back). */
async function enrich(doc: RemediationDoc): Promise<AiPayload | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  // Compact, bounded view of the findings for the prompt.
  const flat = doc.sections.flatMap((s) => s.items.map((it) => ({ ...it, severity: s.severity })));
  const sample = flat.slice(0, MAX_AI_ITEMS).map((it) => ({
    id: it.id,
    severity: it.severity,
    type: it.cls,
    pkg: it.pkg || undefined,
    installed: it.installed || undefined,
    fixed: it.fixedVersion || undefined,
    where: it.where,
    title: it.title || undefined,
    problem: it.description || undefined, // Trivy's explanation of what's wrong
    trivyResolution: it.resolution || undefined, // Trivy's suggested fix, if any
  }));

  const prompt = `You are a senior application-security engineer writing a remediation guide that a DevOps lead will hand to the developers who own the code "${doc.artifact}".

Here are the security findings (already grouped by severity):
${JSON.stringify(sample, null, 2)}

Write practical, developer-facing remediation guidance. Respond with ONLY a JSON object, no prose, in this exact shape:
{
  "summary": "<2-3 sentence executive summary: overall risk and what to prioritise>",
  "sections": [ { "severity": "CRITICAL"|"HIGH"|"MEDIUM"|"LOW"|"UNKNOWN", "overview": "<1-2 sentences on how to approach this tier for THIS repo>" } ],
  "items": [ { "id": "<the finding id>", "recommendation": "<one concrete, actionable sentence telling the developer exactly what to change — name the package/file and the version/edit>" } ]
}
Rules: keep each recommendation specific and imperative. For vulnerable packages, state the upgrade target. For secrets, say to rotate and externalise. For misconfigs, name the fix. Only include ids that appear above.`;

  try {
    const anthropic = new Anthropic({ apiKey });
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < 0) return null;
    return JSON.parse(text.slice(start, end + 1)) as AiPayload;
  } catch {
    return null;
  }
}

/**
 * Generate the remediation document. Always returns a complete, correct doc;
 * `aiEnriched` indicates whether Claude improved the prose/recommendations.
 */
export async function generateRemediationDoc(
  artifact: string,
  findings: TrivyFinding[],
  counts: Record<string, number>,
): Promise<RemediationDoc> {
  const doc = buildSkeleton(artifact, findings, counts);
  if (doc.total === 0) return doc;

  const ai = await enrich(doc);
  if (!ai) return doc;

  // Merge AI prose over the deterministic skeleton (skeleton stays the source of truth for structure).
  if (typeof ai.summary === "string" && ai.summary.trim()) doc.summary = ai.summary.trim();

  if (Array.isArray(ai.sections)) {
    const ov = new Map(ai.sections.filter((s) => s.severity && s.overview).map((s) => [String(s.severity).toUpperCase(), String(s.overview)]));
    for (const sec of doc.sections) {
      const o = ov.get(sec.severity);
      if (o && o.trim()) sec.overview = o.trim();
    }
  }

  if (Array.isArray(ai.items)) {
    const recs = new Map(ai.items.filter((i) => i.id && i.recommendation).map((i) => [String(i.id), String(i.recommendation)]));
    for (const sec of doc.sections) {
      for (const it of sec.items) {
        const r = recs.get(it.id);
        if (r && r.trim()) it.recommendation = r.trim();
      }
    }
  }

  doc.aiEnriched = true;
  return doc;
}
