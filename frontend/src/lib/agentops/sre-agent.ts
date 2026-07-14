/**
 * SRE incident-triage agent — the flagship agentic process.
 *
 * Given an alert, it runs a bounded, READ-ONLY Claude tool-use loop to
 * investigate (pod status, logs, metrics, related alerts, repo) and produces a
 * structured diagnosis: root cause, evidence, and proposed remediation steps —
 * each flagged with risk + whether it needs human approval. It NEVER mutates
 * anything; execution of a remediation step goes through the approval gate.
 *
 * This turns the alert pipeline from "you got an alert" into "here's what's
 * wrong and the fix" — driven by the agent, not fixed backend code.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { prisma } from "@/lib/db/prisma";
import { ALL_TOOLS, executeTool, toAnthropicTools } from "@/lib/agent/tools";
import { createApproval } from "@/lib/devops/approvals";

const MODEL = "claude-sonnet-4-5";
const MAX_TURNS = 8;
const MAX_TOOL_RESULT_CHARS = 8000;

// Read-only tools the SRE agent may use. Deliberately excludes every
// write/mutate tool — investigation only; remediation is proposed, not run.
const INVESTIGATION_TOOLS = new Set([
  "list_alerts",
  "list_kubernetes_resources",
  "get_kubernetes_logs",
  "query_cluster_prometheus",
  "query_prometheus",
  "trivy_scan",
  "list_repos",
  "read_github_file",
  "list_files_in_repo",
  "list_ec2_instances",
  "list_azure_vms",
  "list_gcp_instances",
]);

export type RemediationStep = {
  action: string;
  command?: string;
  risk: "low" | "medium" | "high";
  needsApproval: boolean;
};
export type Diagnosis = {
  summary: string;
  rootCause: string;
  evidence: string[];
  remediation: RemediationStep[];
  confidence: "low" | "medium" | "high";
};
export type TriageResult =
  { ok: true; diagnosis: Diagnosis; toolsUsed: string[] } | { ok: false; error: string };

const SYSTEM = `You are an SRE incident-response agent for a DevOps platform used by NON-DevOps users.
You are given ONE alert. Investigate it with the read-only tools, then explain plainly what is wrong and how to fix it.

Rules:
- Investigate before concluding: use the tools to gather pod status (list_kubernetes_resources), logs (get_kubernetes_logs), metrics (query_cluster_prometheus), related alerts (list_alerts) and, if a repo is involved, its files.
- You have ONLY read-only tools. NEVER claim to have changed anything — you propose fixes, a human approves them.
- Keep tool calls focused; stop once you have enough to diagnose (don't loop forever).
- Write for a non-expert: short, concrete, no jargon dumps.

When done, output ONLY a JSON object (no prose before/after), exactly:
{
  "summary": "<one sentence: what's happening>",
  "rootCause": "<the most likely cause, with the evidence that points to it>",
  "evidence": ["<short fact from a tool result>", "..."],
  "remediation": [
    {"action": "<plain-language fix step>", "command": "<exact kubectl/helm/cloud command if any, else omit>", "risk": "low|medium|high", "needsApproval": true|false}
  ],
  "confidence": "low|medium|high"
}`;

function parseDiagnosis(text: string): Diagnosis | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Partial<Diagnosis>;
    if (!obj.summary || !obj.rootCause) return null;
    return {
      summary: obj.summary,
      rootCause: obj.rootCause,
      evidence: Array.isArray(obj.evidence) ? obj.evidence : [],
      remediation: Array.isArray(obj.remediation) ? obj.remediation : [],
      confidence: obj.confidence ?? "low",
    };
  } catch {
    return null;
  }
}

/** Investigate an alert and return a structured diagnosis + proposed remediation. */
export async function triageAlert(projectId: string, alertId: string): Promise<TriageResult> {
  const alert = await prisma.alert.findFirst({
    where: { id: alertId, projectId },
    include: { env: { select: { key: true } } },
  });
  if (!alert) return { ok: false, error: "Alert not found." };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY isn't set on the server." };
  const anthropic = new Anthropic({ apiKey });

  const tools = toAnthropicTools(ALL_TOOLS.filter((t) => INVESTIGATION_TOOLS.has(t.name)));
  const ctx = { projectId, userId: "sre-agent" };
  const toolsUsed: string[] = [];

  const messages: MessageParam[] = [
    {
      role: "user",
      content:
        `Investigate and diagnose this alert.\n\n` +
        `Title: ${alert.title}\n` +
        `Detail: ${alert.detail}\n` +
        `Resource: ${alert.resource}\n` +
        `Severity: ${alert.severity}\n` +
        `Category: ${alert.category}\n` +
        `Environment: ${alert.env?.key ?? "(unknown)"}\n\n` +
        `Use the tools to gather evidence, then output the JSON diagnosis.`,
    },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let resp;
    try {
      resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1800,
        system: SYSTEM,
        tools,
        messages,
      });
    } catch (e) {
      return {
        ok: false,
        error: `Investigation LLM error: ${e instanceof Error ? e.message : "unknown"}`,
      };
    }

    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason === "tool_use") {
      const results: ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        toolsUsed.push(block.name);
        const r = await executeTool(block.name, block.input, ctx);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(r).slice(0, MAX_TOOL_RESULT_CHARS),
          is_error: !r.ok,
        });
      }
      messages.push({ role: "user", content: results as ContentBlockParam[] });
      continue;
    }

    // Final answer — parse the structured diagnosis.
    const text = resp.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const diagnosis = parseDiagnosis(text);
    if (!diagnosis) return { ok: false, error: "The agent didn't return a parseable diagnosis." };
    // Persist so the UI can show it without the user clicking (auto-triage flow).
    await prisma.alert
      .update({
        where: { id: alertId },
        data: { aiDiagnosis: diagnosis as object, aiDiagnosedAt: new Date() },
      })
      .catch(() => {});
    return { ok: true, diagnosis, toolsUsed };
  }

  return { ok: false, error: "Investigation didn't converge within the turn limit." };
}

export type TriageProposeResult =
  | { ok: true; diagnosis: Diagnosis; toolsUsed: string[]; approvalsCreated: number }
  | { ok: false; error: string };

/**
 * Triage an alert, then push every remediation step that `needsApproval` into
 * the Approval queue — the human approves before anything runs. This closes the
 * agentic loop: alert → agent investigates → proposes fixes → human approves →
 * (Phase: execute). Steps marked needsApproval=false are advisory only.
 */
export async function triageAndPropose(
  projectId: string,
  alertId: string,
): Promise<TriageProposeResult> {
  const res = await triageAlert(projectId, alertId);
  if (!res.ok) return res;

  const alert = await prisma.alert.findFirst({
    where: { id: alertId, projectId },
    select: { envId: true, title: true },
  });
  let approvalsCreated = 0;
  if (alert) {
    for (const step of res.diagnosis.remediation) {
      if (!step.needsApproval) continue;
      try {
        await createApproval({
          projectId,
          envId: alert.envId,
          title: `SRE fix: ${step.action}`.slice(0, 200),
          summary:
            `Proposed by the SRE agent for alert "${alert.title}".\nRoot cause: ${res.diagnosis.rootCause}`.slice(
              0,
              1000,
            ),
          changesSummary: step.command ? step.command.slice(0, 200) : `${step.risk} risk`,
          risk: step.risk,
          diff: [
            { kind: "comment", text: `Why: ${res.diagnosis.rootCause}`.slice(0, 500) },
            { kind: "add", text: step.command || step.action },
          ],
        });
        approvalsCreated++;
      } catch {
        /* best-effort — one bad step shouldn't drop the others */
      }
    }
  }
  return { ok: true, diagnosis: res.diagnosis, toolsUsed: res.toolsUsed, approvalsCreated };
}

/**
 * Event-driven autonomous trigger. Called fire-and-forget when a new alert is
 * created. Gated by SRE_AUTO_TRIAGE=1 so it never runs (or spends tokens)
 * unless explicitly enabled, and limited to high-severity alerts. On enable, a
 * high-severity alert auto-investigates itself and queues proposed fixes for
 * approval — no human in the loop until the approve step. Never throws.
 */
export function maybeAutoTriage(projectId: string, alertId: string, severity: string): void {
  // On by default for HIGH-severity alerts so they auto-investigate the moment
  // they fire; set SRE_AUTO_TRIAGE=0 to disable (e.g. to control token spend).
  if (process.env.SRE_AUTO_TRIAGE === "0") return;
  if (severity !== "high") return;
  void triageAndPropose(projectId, alertId).catch(() => {});
}
