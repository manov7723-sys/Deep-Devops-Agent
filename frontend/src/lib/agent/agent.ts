/**
 * Deep Agent — conversational LLM with tool use.
 *
 * v1 — one Anthropic call per message (runAgentTurn)
 * v2 — streaming via SSE (runAgentTurnStream)
 * v3 — tool-use loop: Claude can call list_project_repos, read_github_file,
 *      etc. The stream keeps running across multiple Claude turns until
 *      `stop_reason !== "tool_use"`.
 *
 * Required env:
 *   ANTHROPIC_API_KEY — your Anthropic console key
 *
 * Model selection — driven by the admin UI, NOT hardcoded:
 *   1. ProjectSetting.defaultModel   (project owner picks in /p/<slug>/settings)
 *   2. Model.isDefault=true          (super-admin picks in /admin/models)
 *   3. DDA_AGENT_MODEL env           (server bootstrap override)
 *   4. FALLBACK_MODEL                (compiled-in safety net)
 */
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import OpenAI from "openai";
import { prisma } from "@/lib/db/prisma";
import { ALL_TOOLS, executeTool, toAnthropicTools, toolsForClouds, type Tool } from "./tools";

export type ResolvedModel = {
  name: string;
  provider: "Anthropic" | "OpenAI" | "SelfHosted" | "Google" | "Groq";
};

const FALLBACK_MODEL: ResolvedModel = { name: "claude-sonnet-4-5", provider: "Anthropic" };
// How many past messages to feed the model. Lower it (env override) to fit a
// tight per-minute token budget like Groq's free tier.
const HISTORY_LIMIT = Number(process.env.DDA_AGENT_HISTORY_LIMIT) || 20;
// Max completion tokens we reserve. Providers like Groq count this RESERVATION
// against the per-minute token limit (TPM), so on the free tier a big value
// (4096) alone can push a request over the cap. Override via DDA_MAX_OUTPUT_TOKENS.
const MAX_OUTPUT_TOKENS = Number(process.env.DDA_MAX_OUTPUT_TOKENS) || 4096;

/**
 * Standing infra workflow the agent must follow for every cloud/AWS request:
 * ask requirements first, then always offer the three execution modes, then act
 * with the right tools. Kept in the system prompt so the behaviour is consistent
 * across every chat turn.
 */
const OPTIONS_RULE =
  'For any question with choices, emit EXACTLY one fenced ```options``` block — a single-line JSON object and nothing after it, e.g. {"question":"Which AWS region?","options":["us-east-1","us-west-2","Custom"],"key":"region"}. One question per message; WAIT for the answer; add "Custom" when free text is OK; never list choices as bullets or output raw JSON outside the block.';

const INFRA_PLAYBOOK = [
  "## Infrastructure (AWS/cloud) requests",
  "To create/change ANY cloud infra (S3, RDS, VPC, EKS, IAM, Lambda, security groups…), run a guided wizard:",
  `- Ask requirements ONE at a time. ${OPTIONS_RULE} Gather: resource specifics, name (globally-unique where needed), region, environment, repo (for push), prod settings (encryption, HA, tags).`,
  '- Then show a short SUMMARY and ask the mode: ```options``` {"question":"How should I create it?","options":["Generate & push to GitHub","Generate, push & apply","Apply directly","Cancel"],"key":"mode"}.',
  "- EKS → ALWAYS provision_eks (mode push|apply|push_and_apply); NEVER hand-write EKS Terraform. Other resources → write production-grade Terraform (encryption, least-privilege, remote state); Push = write_repo_file openPullRequest=true; Apply = run_terraform action=apply (plan first). Use a stable descriptive `stack` name and REUSE it across runs. Apply only when the user picked an apply mode.",
].join("\n");

/**
 * Manifest wizard the agent runs when asked to create a Kubernetes YAML file —
 * the chat equivalent of the static manifest builder. Deterministic generation
 * via tools; the agent only drives the Q&A and the push.
 */
const MANIFEST_PLAYBOOK = [
  "## Kubernetes manifest requests (deployment, service, configmap, secret, ingress, hpa, serviceaccount…)",
  "1. list_k8s_manifest_kinds for supported apiVersions/kinds/fields.",
  "2. Ask via ```options``` one at a time: apiVersion, kind, then each field (name, namespace, image, replicas, port…). WAIT for each.",
  "3. generate_k8s_manifest with the values — NEVER hand-write YAML. Show the result.",
  '4. Ask what to do next via ```options``` ["Apply to cluster","Push to GitHub","Both","Cancel"]. Apply → ask which env (if >1 connected) then apply_k8s_manifest with that envKey + the generated YAML (offer dryRun=true first to validate); report what changed. Push → ask repo + path (default k8s/<ns>/<kind>-<name>.yaml), then write_repo_file openPullRequest=true; share the PR link.',
].join("\n");

/**
 * Helm chart wizard — the chat equivalent of the static Helm chart builder.
 * Deterministic generation via tools; the agent drives the Q&A, the push, and
 * the optional deploy.
 */
const HELM_PLAYBOOK = [
  "## Helm chart requests (build/package/deploy a Helm chart)",
  "1. list_helm_chart_fields for fields/types/options/defaults.",
  "2. Ask via ```options``` one at a time: at least app name + image repository; offer to accept defaults for the rest (tag, port, replicas, service type, ingress, autoscaling, env, resources). WAIT for each.",
  "3. generate_helm_chart with the values — NEVER hand-write chart YAML. Summarise the files.",
  "4. Ask next via ```options``` ['Push to GitHub','Push & deploy','Deploy directly','Cancel']. Push → write_repo_file per file under charts/<name> (openPullRequest=true on the FIRST file only = one PR); share the link. Deploy → run_helm_upgrade (env, chart repo+dir, releaseName, image repo/tag); report rollout.",
].join("\n");

/**
 * CI playbook — the chat flow for "set up CI / containerize my repo / build &
 * push to ECR". The agent READS and ANALYSES the connected repo, then AUTHORS
 * the Dockerfile, docker-compose, and GitHub Actions workflow itself (LLM
 * generation), wiring keyless ECR pushes via the setup_github_oidc_ecr tool.
 */
const CI_PLAYBOOK = [
  "## CI / containerization (Docker + GitHub Actions → ECR)",
  "For 'set up CI / containerize / write a Dockerfile / build & push to ECR':",
  "1. Analyse the repo (ask which if >1). list_files_in_repo + read_github_file on package.json / requirements.txt / go.mod / pom.xml / etc. to detect language+version, framework, build & start commands, and the PORT. If a Dockerfile/workflow exists, ask before overwriting.",
  "2. Generate Docker files: list_dockerfile_stacks, then generate_dockerfile with the matched stack + detected params (buildDir, buildCommand, port, startCommand, version) → vetted Dockerfile/.dockerignore/compose/nginx.conf. NEVER hand-write a Dockerfile a template covers (the LLM reproduces broken patterns). If NO stack fits (Java, Rails, Rust, .NET, PHP…), hand-write a production Dockerfile (multi-stage, pinned base, non-root, correct EXPOSE, exec-form CMD) + .dockerignore + compose. Confirm the build output dir (Vite=dist, CRA=build) via ```options``` if unsure.",
  "3. verify_docker_build with the generated files — runs a real docker build, no commit/tokens. If built=false, read `log`, fix, verify again until it builds. If docker isn't on the server, warn and proceed carefully.",
  "4. setup_github_oidc_ecr (repoFullName, optional ecrRepoName/region) → creates the OIDC provider + repo-scoped IAM role + ECR push policy + ECR repo; returns roleArn + ecrRepositoryUri + region. Report `steps`. Needs an AWS account connected.",
  "5. generate_ecr_workflow with those values (NEVER hand-write the YAML) → .github/workflows/build-and-push.yml. Explain the flow (checkout → OIDC assume-role → ECR login → build → push) and ASK: are you satisfied — save this to the CI/CD pipeline?",
  "6. Do NOT push to GitHub here. On 'yes', call save_pipeline_to_project (repoFullName, a short name, ALL generated files) — this saves the pipeline to the project's CI/CD tab where the user edits the script and clicks 'Run pipeline' (that step commits it to the default branch + triggers the GitHub Actions run, all monitored in-app). Tell the user it's saved to the CI/CD tab and they can edit + Run it there. Only use write_repo_file (PR) instead if the user explicitly asks for a pull request rather than the CI/CD pipeline.",
].join("\n");

/**
 * CI → cloud registry playbook for GCP (Artifact Registry) and Azure (ACR),
 * both keyless. Included only when the matching cloud is connected. The agent
 * MUST ask new-vs-existing registry, then set up keyless auth, then generate.
 */
const CI_REGISTRY_PLAYBOOK = [
  "## CI workflow → cloud container registry (GCP Artifact Registry / Azure ACR), keyless",
  "When the user wants a CI workflow that builds & PUSHES the image to GCP or Azure (not AWS/ECR):",
  "1. FIRST ASK the user: create a NEW registry, or use an EXISTING one? Do not assume.",
  "GCP (Artifact Registry):",
  "  - Existing → list_artifact_registries(location) and let them pick (ask the location, default us-central1).",
  "  - New → create_artifact_registry(location, repository).",
  "  - Then setup_gcp_github_wif(repoFullName) → keyless Workload Identity Federation; returns workloadIdentityProvider + serviceAccount.",
  "  - Then generate_gar_workflow(workloadIdentityProvider, serviceAccount, location, repository, image, branch) → the workflow YAML. NEVER hand-write it.",
  "Azure (ACR):",
  "  - Existing → list_acr() and let them pick.",
  "  - New → create_acr(resourceGroup, name, location). (ACR names: global, lowercase, alphanumeric.)",
  "  - Then setup_azure_github_oidc(repoFullName, acrName, resourceGroup) → keyless federated credential; returns clientId/tenantId/subscriptionId. NOTE: needs a service-principal Azure connection; if it errors about that, relay the message.",
  "  - Then generate_acr_workflow(clientId, tenantId, subscriptionId, registry, image, branch) → the workflow YAML. NEVER hand-write it.",
  "2. Show the generated workflow, explain the keyless flow (GitHub OIDC → cloud, no stored secret), and ASK before committing. On 'yes' commit with write_repo_file (PR) or save_pipeline_to_project per the user's preference.",
].join("\n");

/**
 * Azure context playbook — included only for projects with Azure connected.
 * Drives the subscription → resource group → region selection so the agent
 * always has the right scope before running any Azure command.
 */
const AZURE_PLAYBOOK = [
  "## Azure requests (VMs, resource groups, deploys) — establish context FIRST",
  "Before ANY Azure action, make sure you know the subscription, resource group, and (if creating) the region. Never guess them.",
  "0. If the 'Active Azure context' section above already has the values you need, USE them directly — do NOT re-run the selection. Only run the steps below for a value that's missing or when the user asks to change it.",
  "1. Subscription: call list_azure_subscriptions. If more than one, ask the user which via an ```options``` block (one option per subscription, label = name, plus 'Custom'). If only one, use it and say so.",
  "2. Resource group: call list_azure_resource_groups for the chosen subscription, then ask which via an ```options``` block (skip only for subscription-wide reads like 'list all VMs'). Offer 'Create new' + 'Custom' when relevant.",
  "3. Region (only when CREATING a resource): ask via an ```options``` block — East US, West Europe, Southeast Asia, Central US, Custom.",
  "4. As soon as the user picks subscription / resource group / region, call set_azure_context to SAVE them so you (and future chats) remember. Then for list_azure_vms pass the chosen resourceGroup (omit it only for a subscription-wide list).",
  "5. If no Azure account is connected, tell the user to connect one with 'Sign in with Microsoft' on the Cloud providers tab — don't guess.",
].join("\n");

/** GCP context playbook — included only for projects with GCP connected. */
const GCP_PLAYBOOK = [
  "## GCP requests (Compute instances, deploys) — establish the project FIRST",
  "GCP work always targets a specific GCP PROJECT. Never guess it.",
  "0. If the 'Active GCP context' above already has the project you need, USE it — don't re-ask. Only run selection when it's missing or the user wants to switch projects.",
  "1. Call list_gcp_projects. If more than one, ask the user which via an ```options``` block (label = name, value = projectId, plus 'Custom'). If only one, use it.",
  "2. Region (only when CREATING a resource): ask via an ```options``` block — us-central1, us-east1, europe-west1, asia-south1, Custom.",
  "3. As soon as the user picks the project/region, call set_gcp_context to SAVE it. Then list_gcp_instances uses that project automatically.",
  "4. If a tool reports the Compute Engine API is disabled, tell the user to enable it at console.cloud.google.com/apis/library/compute.googleapis.com for that project, then retry.",
  "5. If no GCP account is connected, tell the user to connect one with 'Sign in with Google' on the Cloud providers tab — don't guess.",
].join("\n");

/**
 * Compact knowledge-base context for a project. Token-budget-conscious: a few
 * recent docs, each truncated. Empty string when the project has no KB docs.
 */
async function loadKnowledgeContext(projectId: string): Promise<string> {
  try {
    const docs = await prisma.knowledgeDoc.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { title: true, body: true, type: true },
    });
    const withBody = docs.filter((d) => (d.body ?? "").trim()).slice(0, 6);
    if (withBody.length === 0) return "";
    const parts = withBody.map(
      (d) => `### ${d.title}${d.type ? ` (${d.type})` : ""}\n${(d.body ?? "").slice(0, 600).trim()}`,
    );
    return (
      "## Project knowledge base\n" +
      "Use these project docs/conventions when answering and when generating infrastructure:\n\n" +
      parts.join("\n\n")
    );
  } catch {
    return "";
  }
}

/**
 * Build the agent's system prompt: identity + project context + the standing
 * infra playbook + the project's knowledge base. Shared by the streaming and
 * non-streaming paths so they never drift.
 */
/**
 * List the project's environments that have a Kubernetes cluster connected, so
 * the agent knows which env key to pass to list_kubernetes_resources /
 * get_kubernetes_logs when the user says "list pods", "list nodes", etc.
 */
async function loadClusterContext(projectId: string): Promise<string> {
  try {
    const envs = await prisma.env.findMany({
      where: { projectId, kubeconfigRef: { not: null } },
      select: { key: true, name: true, namespace: true },
    });
    if (envs.length === 0) return "";
    const lines = envs.map((e) => `- env "${e.key}"${e.name ? ` (${e.name})` : ""}, default namespace "${e.namespace}"`);
    return (
      "## Connected Kubernetes clusters\n" +
      "These environments have a live cluster connected. When the user asks to list pods/nodes/services, get logs, etc., call list_kubernetes_resources / get_kubernetes_logs with the matching env key (no need to ask which env if there's only one):\n" +
      lines.join("\n")
    );
  } catch {
    return "";
  }
}

/**
 * The project's SAVED Azure context (subscription / resource group / region).
 * Surfaced so the agent already knows the scope and doesn't re-ask every time.
 */
async function loadAzureContext(projectId: string): Promise<string> {
  try {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId, kind: "azure" },
      select: { accountRef: true, resourceGroup: true, region: true, cloudEnvironment: true },
    });
    if (!cp) return "";
    return [
      "## Active Azure context for this project",
      `- Subscription: ${cp.accountRef}`,
      `- Resource group: ${cp.resourceGroup ?? "(not set — ask the user to pick one)"}`,
      `- Region: ${cp.region}`,
      `- Cloud environment: ${cp.cloudEnvironment}`,
      "Use this saved context for Azure commands without re-asking. Only run the subscription/resource-group/region selection flow if a value is missing or the user wants to change it — and call set_azure_context after they pick.",
    ].join("\n");
  } catch {
    return "";
  }
}

/** The project's SAVED GCP context (project + region). */
async function loadGcpContext(projectId: string): Promise<string> {
  try {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId, kind: "gcp" },
      select: { accountRef: true, region: true },
    });
    if (!cp) return "";
    return [
      "## Active GCP context for this project",
      `- GCP project: ${cp.accountRef}`,
      `- Region: ${cp.region}`,
      "Use this saved project for GCP commands without re-asking. Only run the project/region selection flow if the user wants to switch — and call set_gcp_context after they pick.",
    ].join("\n");
  } catch {
    return "";
  }
}

async function buildSystemPrompt(projectId: string): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, slug: true, description: true },
  });
  const kb = await loadKnowledgeContext(projectId);
  const clusters = await loadClusterContext(projectId);

  // ISOLATION: tell the agent which clouds THIS project is connected to. Only
  // the matching cloud tools are exposed, so it must not offer/assume others.
  const clouds = await getProjectClouds(projectId);
  const cloudLine =
    clouds.size > 0
      ? `## Connected clouds for this project: ${[...clouds].map((c) => c.toUpperCase()).join(", ")}. Only act on these. You have tools ONLY for the connected cloud(s); this project is NOT connected to the others, so don't try them or ask for their accounts.`
      : "## This project has NO cloud account connected yet. If the user asks about cloud resources (VMs, EC2, etc.), tell them to connect an account on the Cloud providers tab first — don't guess.";
  const azureCtx = clouds.has("azure") ? await loadAzureContext(projectId) : "";
  const gcpCtx = clouds.has("gcp") ? await loadGcpContext(projectId) : "";

  return [
    "You are Deep Agent, an AI assistant inside a DevOps platform called DeepAgent.",
    "You help engineers reason about their infrastructure, repositories, deployments and cloud resources.",
    project
      ? `Current project: "${project.name}" (slug: ${project.slug}). ${project.description ?? ""}`.trim()
      : "",
    "Be concise. When you don't know something specific about the user's infra, say so plainly rather than guess.",
    cloudLine,
    azureCtx,
    gcpCtx,
    INFRA_PLAYBOOK,
    MANIFEST_PLAYBOOK,
    HELM_PLAYBOOK,
    CI_PLAYBOOK,
    clouds.has("gcp") || clouds.has("azure") ? CI_REGISTRY_PLAYBOOK : "",
    clouds.has("azure") ? AZURE_PLAYBOOK : "",
    clouds.has("gcp") ? GCP_PLAYBOOK : "",
    clusters,
    kb,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Resolve which Claude model to use for this project.
 *
 * Priority:
 *   1. Project's `ProjectSetting.defaultModel.name`         (per-project pick)
 *   2. `Model` row with `isDefault=true && enabled=true`    (admin default)
 *   3. `DDA_AGENT_MODEL` env var                            (server override)
 *   4. FALLBACK_MODEL                                       (hardcoded)
 *
 * Disabled / soft-deleted models are skipped — the chain advances. This
 * means the admin can flip `enabled=false` on a model and the next-in-line
 * automatically takes over without anyone editing code.
 */
async function resolveModel(projectId: string): Promise<ResolvedModel> {
  try {
    const setting = await prisma.projectSetting.findUnique({
      where: { projectId },
      select: {
        defaultModel: { select: { name: true, provider: true, enabled: true } },
      },
    });
    if (setting?.defaultModel?.enabled && setting.defaultModel.name) {
      return {
        name: setting.defaultModel.name,
        provider: setting.defaultModel.provider,
      };
    }
    const platformDefault = await prisma.model.findFirst({
      where: { isDefault: true, enabled: true },
      select: { name: true, provider: true },
    });
    if (platformDefault?.name) {
      return { name: platformDefault.name, provider: platformDefault.provider };
    }
  } catch {
    /* Model table not migrated yet — fall through to env / fallback. */
  }
  // Env override: DDA_AGENT_MODEL=openai:gpt-4o, groq:llama-3.3-70b-versatile,
  // or just the bare model id (provider inferred from the slug).
  const env = process.env.DDA_AGENT_MODEL;
  if (env) {
    const [maybeProvider, ...rest] = env.split(":");
    if (rest.length > 0 && maybeProvider) {
      const p = maybeProvider.toLowerCase();
      const provider =
        p === "openai"
          ? "OpenAI"
          : p === "anthropic"
            ? "Anthropic"
            : p === "groq"
              ? "Groq"
              : p === "google" || p === "gemini"
                ? "Google"
                : null;
      if (provider) return { name: rest.join(":"), provider };
    }
    return inferProvider(env);
  }
  return FALLBACK_MODEL;
}

function inferProvider(name: string): ResolvedModel {
  const n = name.toLowerCase();
  if (n.startsWith("gpt") || n.startsWith("o1") || n.startsWith("o3") || n.startsWith("o4")) {
    return { name, provider: "OpenAI" };
  }
  if (n.startsWith("gemini") || n.startsWith("models/gemini")) {
    return { name, provider: "Google" };
  }
  if (
    n.startsWith("llama") ||
    n.startsWith("mixtral") ||
    n.startsWith("gemma") ||
    n.startsWith("qwen") ||
    n.startsWith("deepseek") ||
    n.includes("-groq")
  ) {
    return { name, provider: "Groq" };
  }
  return { name, provider: "Anthropic" };
}

let _anthropic: Anthropic | null = null;
function client(): Anthropic {
  if (_anthropic) return _anthropic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is not set.");
  _anthropic = new Anthropic({ apiKey });
  return _anthropic;
}

let _openai: OpenAI | null = null;
function openaiClient(): OpenAI {
  if (_openai) return _openai;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY env var is not set.");
  _openai = new OpenAI({ apiKey });
  return _openai;
}

/**
 * Groq exposes an OpenAI-compatible Chat Completions API at a different
 * base URL. We can reuse the OpenAI SDK + the OpenAI tool-use loop verbatim;
 * just swap the client.
 */
let _groq: OpenAI | null = null;
function groqClient(): OpenAI {
  if (_groq) return _groq;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY env var is not set.");
  _groq = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });
  return _groq;
}

/**
 * Google's Gemini exposes an OpenAI-compatible Chat Completions API (with
 * function calling) at a dedicated base URL. Same deal as Groq — reuse the
 * OpenAI SDK + tool-use loop verbatim, just swap the client + key.
 */
let _gemini: OpenAI | null = null;
function geminiClient(): OpenAI {
  if (_gemini) return _gemini;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY env var is not set.");
  _gemini = new OpenAI({
    apiKey,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  });
  return _gemini;
}

/** Pick the OpenAI-shaped client for a given provider (OpenAI / Groq / Google). */
function openAIShapedClient(provider: ResolvedModel["provider"]): OpenAI {
  if (provider === "Groq") return groqClient();
  if (provider === "Google") return geminiClient();
  return openaiClient();
}

/** Convert ALL_TOOLS to OpenAI's `function` tool format. */
function toOpenAITools(list: Tool[] = ALL_TOOLS): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return list.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  })) as unknown as OpenAI.Chat.Completions.ChatCompletionTool[];
}

/** The clouds (aws/azure/gcp) this project has connected — drives tool + prompt isolation. */
async function getProjectClouds(projectId: string): Promise<Set<string>> {
  try {
    const rows = await prisma.cloudProvider.findMany({
      where: { projectId },
      select: { kind: true },
      distinct: ["kind"],
    });
    return new Set(rows.map((r) => r.kind));
  } catch {
    return new Set();
  }
}

/**
 * One-shot, tool-free completion using the project's resolved model. Used by
 * non-chat features (e.g. the CI auto-heal reviewer) that just need the model
 * to transform text. Returns the raw assistant text.
 */
export async function completeText(args: {
  projectId: string;
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const model = await resolveModel(args.projectId);
  const max = args.maxTokens ?? MAX_OUTPUT_TOKENS;
  try {
    if (model.provider === "OpenAI" || model.provider === "Groq" || model.provider === "Google") {
      const completion = await openAIShapedClient(model.provider).chat.completions.create({
        model: model.name,
        max_tokens: max,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.prompt },
        ],
      });
      return { ok: true, text: completion.choices[0]?.message?.content?.trim() ?? "" };
    }
    const completion = await client().messages.create({
      model: model.name,
      max_tokens: max,
      system: args.system,
      messages: [{ role: "user", content: args.prompt }],
    });
    const text = completion.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "completion failed" };
  }
}

export type AgentRunResult =
  | { ok: true; agentMessageId: string; text: string }
  | { ok: false; code: "missing_api_key" | "thread_not_found" | "upstream_error"; message: string };

export type AgentStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call_start"; toolUseId: string; name: string }
  | { type: "tool_call_input"; toolUseId: string; input: unknown }
  | { type: "tool_call_result"; toolUseId: string; ok: boolean; summary: string }
  | { type: "turn_end"; reason: string }
  | { type: "done"; agentMessageId: string; text: string }
  | { type: "error"; code: "missing_api_key" | "thread_not_found" | "upstream_error"; message: string };

const MAX_TOOL_LOOPS = 10;

/**
 * Run one turn of the agent inside a thread. Caller should already have
 * persisted the user's message; this function loads the last N messages
 * (including the just-posted user one), calls Claude, then writes the agent's
 * reply back to the same thread.
 */
export async function runAgentTurn(args: {
  projectId: string;
  threadId: string;
  agentId?: string | null;
}): Promise<AgentRunResult> {
  // No unconditional Anthropic gate here — the per-provider key check below
  // (and the Anthropic client() initializer) handle the key for whichever
  // provider the resolved model uses. This lets a Groq-only / OpenAI-only
  // deployment run without an ANTHROPIC_API_KEY set.

  const thread = await prisma.chatThread.findFirst({
    where: { id: args.threadId, projectId: args.projectId },
    select: { id: true },
  });
  if (!thread) {
    return { ok: false, code: "thread_not_found", message: "Thread not found." };
  }

  // Pull the last N messages oldest-first so Claude sees the conversation in
  // the right order.
  const history = await prisma.chatMessage.findMany({
    where: { threadId: args.threadId, role: { in: ["user", "agent"] } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, text: true },
  });
  history.reverse();

  // Identity + project context + standing infra playbook + knowledge base.
  const system = await buildSystemPrompt(args.projectId);

  const messages = history.map((m) => ({
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    content: m.text,
  }));

  let text: string;
  const model = await resolveModel(args.projectId);
  try {
    if (model.provider === "OpenAI" || model.provider === "Groq" || model.provider === "Google") {
      const requiredKey =
        model.provider === "Groq"
          ? "GROQ_API_KEY"
          : model.provider === "Google"
            ? "GEMINI_API_KEY"
            : "OPENAI_API_KEY";
      if (!process.env[requiredKey]) {
        return {
          ok: false,
          code: "missing_api_key",
          message: `${requiredKey} isn't configured on the server.`,
        };
      }
      const completion = await openAIShapedClient(model.provider).chat.completions.create({
        model: model.name,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: system },
          ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string })),
        ],
      });
      text = completion.choices[0]?.message?.content?.trim() ?? "";
    } else {
      const completion = await client().messages.create({
        model: model.name,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages,
      });
      text = completion.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim();
    }
    if (!text) text = "(no response)";
  } catch (err) {
    return {
      ok: false,
      code: "upstream_error",
      message: err instanceof Error ? err.message : "Unknown upstream error.",
    };
  }

  const saved = await prisma.chatMessage.create({
    data: {
      projectId: args.projectId,
      threadId: args.threadId,
      role: "agent",
      agentId: args.agentId ?? null,
      text,
    },
    select: { id: true },
  });
  await prisma.chatThread.update({
    where: { id: args.threadId },
    data: { updatedAt: new Date() },
  });

  return { ok: true, agentMessageId: saved.id, text };
}

/**
 * Streaming variant of `runAgentTurn`. Yields events the SSE endpoint can
 * forward verbatim to the browser. Persists the final assistant message in
 * the `done` event right before yielding it, so the client can read its id
 * and treat the streamed message as canonical.
 */
export async function* runAgentTurnStream(args: {
  projectId: string;
  threadId: string;
  agentId?: string | null;
}): AsyncGenerator<AgentStreamEvent, void, void> {
  const thread = await prisma.chatThread.findFirst({
    where: { id: args.threadId, projectId: args.projectId },
    select: { id: true },
  });
  if (!thread) {
    yield { type: "error", code: "thread_not_found", message: "Thread not found." };
    return;
  }

  const model = await resolveModel(args.projectId);

  // Per-provider API key gate. We do this BEFORE preparing messages so a
  // missing key fails fast rather than after a DB read.
  const keyEnvForProvider: Record<string, string> = {
    Anthropic: "ANTHROPIC_API_KEY",
    OpenAI: "OPENAI_API_KEY",
    Groq: "GROQ_API_KEY",
    Google: "GEMINI_API_KEY",
  };
  const requiredKey = keyEnvForProvider[model.provider];
  if (requiredKey && !process.env[requiredKey]) {
    yield {
      type: "error",
      code: "missing_api_key",
      message: `${requiredKey} isn't configured on the server.`,
    };
    return;
  }
  if (!requiredKey) {
    yield {
      type: "error",
      code: "upstream_error",
      message: `Provider "${model.provider}" isn't supported by the agent runtime yet.`,
    };
    return;
  }

  const history = await prisma.chatMessage.findMany({
    where: { threadId: args.threadId, role: { in: ["user", "agent"] } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, text: true },
  });
  history.reverse();

  // Identity + project context + standing infra playbook + knowledge base.
  const system = await buildSystemPrompt(args.projectId);

  const userAssistantHistory = history.map((m) => ({
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    text: m.text,
  }));

  // ISOLATION: only expose the cloud tools for the clouds THIS project has
  // connected (agnostic tools are always included). An Azure-only project never
  // sees AWS tools, so the agent can't fumble onto the wrong cloud — and the
  // smaller tool set also makes the model respond faster.
  const clouds = await getProjectClouds(args.projectId);
  const projectTools = toolsForClouds(clouds);

  // Dispatch to the provider's tool-use loop. Each implementation yields the
  // same AgentStreamEvent shape, and the accumulator below survives across
  // multiple tool-loop turns so the final text is the full assistant reply.
  let accumulated = "";
  const innerLoop =
    model.provider === "OpenAI" || model.provider === "Groq" || model.provider === "Google"
      ? runOpenAILoop({
          model: model.name,
          system,
          history: userAssistantHistory,
          projectId: args.projectId,
          provider: model.provider,
          tools: projectTools,
        })
      : runAnthropicLoop({
          model: model.name,
          system,
          history: userAssistantHistory,
          projectId: args.projectId,
          tools: projectTools,
        });

  for await (const ev of innerLoop) {
    if (ev.type === "delta") accumulated += ev.text;
    if (ev.type === "error") {
      yield ev;
      return;
    }
    yield ev;
  }

  const finalText = accumulated.trim() || "(no response)";
  const saved = await prisma.chatMessage.create({
    data: {
      projectId: args.projectId,
      threadId: args.threadId,
      role: "agent",
      agentId: args.agentId ?? null,
      text: finalText,
    },
    select: { id: true },
  });
  await prisma.chatThread.update({
    where: { id: args.threadId },
    data: { updatedAt: new Date() },
  });

  yield { type: "done", agentMessageId: saved.id, text: finalText };
}

type ProviderLoopArgs = {
  model: string;
  system: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  projectId: string;
  /** Tools available for this project (already filtered to its connected clouds). */
  tools: Tool[];
};

async function* runAnthropicLoop(args: ProviderLoopArgs): AsyncGenerator<AgentStreamEvent, void, void> {
  const messages: MessageParam[] = args.history.map((m) => ({
    role: m.role,
    content: m.text,
  }));
  const tools = toAnthropicTools(args.tools);
  const toolCtx = { projectId: args.projectId, userId: "" };

  loop: for (let turn = 0; turn < MAX_TOOL_LOOPS; turn++) {
    // Per-turn buffers: tool_use blocks the model emits, plus a small map
    // from content_block_index -> running input-json string we accumulate
    // from `input_json_delta` events.
    const toolUseBlocks: Array<{ id: string; name: string; input: unknown }> = [];
    const inputJsonByIndex = new Map<number, string>();
    const idByIndex = new Map<number, string>();
    const nameByIndex = new Map<number, string>();
    let stopReason: string = "end_turn";

    try {
      const stream = client().messages.stream({
        model: args.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: args.system,
        messages,
        tools,
      });

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "tool_use") {
            idByIndex.set(event.index, block.id);
            nameByIndex.set(event.index, block.name);
            inputJsonByIndex.set(event.index, "");
            yield {
              type: "tool_call_start",
              toolUseId: block.id,
              name: block.name,
            };
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { type: "delta", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const cur = inputJsonByIndex.get(event.index) ?? "";
            inputJsonByIndex.set(event.index, cur + event.delta.partial_json);
          }
        } else if (event.type === "content_block_stop") {
          // If this block was a tool_use, the input JSON is now complete.
          if (idByIndex.has(event.index)) {
            const raw = inputJsonByIndex.get(event.index) ?? "{}";
            let parsed: unknown = {};
            try {
              parsed = JSON.parse(raw || "{}");
            } catch {
              parsed = {};
            }
            const id = idByIndex.get(event.index)!;
            const name = nameByIndex.get(event.index)!;
            toolUseBlocks.push({ id, name, input: parsed });
            yield { type: "tool_call_input", toolUseId: id, input: parsed };
          }
        } else if (event.type === "message_delta") {
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
        }
      }

      // The SDK exposes the final assembled message — we need its `content`
      // (text + tool_use blocks) to push back into `messages` so the next
      // turn has full context.
      const finalMessage = await stream.finalMessage();
      messages.push({ role: "assistant", content: finalMessage.content });
      yield { type: "turn_end", reason: stopReason };
    } catch (err) {
      yield {
        type: "error",
        code: "upstream_error",
        message: err instanceof Error ? err.message : "Unknown upstream error.",
      };
      return;
    }

    // If Claude didn't request tools, we're done.
    if (stopReason !== "tool_use" || toolUseBlocks.length === 0) {
      break loop;
    }

    // Execute every tool call sequentially, build the tool_result content
    // for the next turn.
    const resultContent: ContentBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      const res = await executeTool(tu.name, tu.input, toolCtx);
      const payload = res.ok ? res.output : { error: res.error };
      const summary = res.ok
        ? `Returned ${JSON.stringify(res.output).length} bytes of JSON.`
        : `Error: ${res.error}`;
      yield {
        type: "tool_call_result",
        toolUseId: tu.id,
        ok: res.ok,
        summary,
      };
      resultContent.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(payload),
        is_error: !res.ok,
      });
    }
    messages.push({ role: "user", content: resultContent });
    // Continue loop — Claude will read the tool results and respond again.
  }
}

/**
 * OpenAI tool-use loop. Uses Chat Completions streaming, which yields
 * deltas with either `content` (text token) or `tool_calls` (function-call
 * fragments). We accumulate tool_call.function.arguments JSON chunks per
 * index, execute the tools when the message stops with
 * finish_reason="tool_calls", and feed the results back as `role: "tool"`
 * messages — the format the API expects.
 */
async function* runOpenAILoop(
  args: ProviderLoopArgs & { provider: ResolvedModel["provider"] },
): AsyncGenerator<AgentStreamEvent, void, void> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: args.system },
    ...args.history.map((m) => ({ role: m.role, content: m.text }) as OpenAI.Chat.Completions.ChatCompletionMessageParam),
  ];
  const tools = toOpenAITools(args.tools);
  const toolCtx = { projectId: args.projectId, userId: "" };
  // Groq + OpenAI share the same Chat Completions wire format, so the same
  // streaming loop works for both — only the client differs.
  const provider = openAIShapedClient(args.provider);

  for (let turn = 0; turn < MAX_TOOL_LOOPS; turn++) {
    let assistantText = "";
    // Per-turn buffers — OpenAI streams tool_calls in fragments keyed by index.
    type ToolBuf = { id: string; name: string; argsJson: string; yieldedStart: boolean };
    const buffers: Record<number, ToolBuf> = {};
    let finishReason: string = "stop";

    // Groq's llama models intermittently emit a malformed tool call that the
    // API rejects (400 "Failed to call a function … failed_generation"), and
    // free tiers throw 503 "over capacity". Both are transient — retry the SAME
    // turn a few times so the agent self-recovers instead of hard-failing.
    const MAX_TURN_RETRIES = 3;
    let fatalErr: unknown = null;
    for (let attempt = 0; ; attempt++) {
      assistantText = "";
      finishReason = "stop";
      for (const k of Object.keys(buffers)) delete buffers[Number(k)];
      let yieldedThisAttempt = false;
      try {
        const stream = await provider.chat.completions.create({
          model: args.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages,
          tools,
          stream: true,
        });

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice) continue;

          if (choice.delta.content) {
            const text = choice.delta.content;
            assistantText += text;
            yieldedThisAttempt = true;
            yield { type: "delta", text };
          }

          if (choice.delta.tool_calls) {
            for (const piece of choice.delta.tool_calls) {
              const idx = piece.index;
              if (!buffers[idx]) {
                buffers[idx] = { id: "", name: "", argsJson: "", yieldedStart: false };
              }
              const buf = buffers[idx]!;
              if (piece.id) buf.id = piece.id;
              if (piece.function?.name) buf.name = piece.function.name;
              if (piece.function?.arguments) buf.argsJson += piece.function.arguments;
              // First time we know the name + id, emit the start event.
              if (!buf.yieldedStart && buf.name && buf.id) {
                buf.yieldedStart = true;
                yieldedThisAttempt = true;
                yield { type: "tool_call_start", toolUseId: buf.id, name: buf.name };
              }
            }
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        fatalErr = null;
        break; // success
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const transient = /failed.to.call.a.function|failed_generation|over capacity|503|429/i.test(msg);
        // Only retry when nothing was streamed yet this attempt (so we never
        // duplicate visible output). failed_generation / 503 occur pre-content.
        if (transient && !yieldedThisAttempt && attempt < MAX_TURN_RETRIES) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        fatalErr = err;
        break;
      }
    }
    if (fatalErr) {
      yield {
        type: "error",
        code: "upstream_error",
        message: fatalErr instanceof Error ? fatalErr.message : "Unknown upstream error.",
      };
      return;
    }

    const toolCalls = Object.values(buffers);

    // Push the assistant turn (text + tool calls) so the next call has
    // context.
    messages.push({
      role: "assistant",
      content: assistantText || null,
      ...(toolCalls.length > 0 && {
        tool_calls: toolCalls.map((t) => ({
          id: t.id,
          type: "function" as const,
          function: { name: t.name, arguments: t.argsJson },
        })),
      }),
    } as OpenAI.Chat.Completions.ChatCompletionMessageParam);

    yield { type: "turn_end", reason: finishReason };

    if (finishReason !== "tool_calls" || toolCalls.length === 0) {
      // Conversation is done.
      return;
    }

    // Execute every tool call and append its result as a `role: "tool"`
    // message — OpenAI's required shape for tool-call responses.
    for (const tc of toolCalls) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.argsJson || "{}");
      } catch {
        input = {};
      }
      yield { type: "tool_call_input", toolUseId: tc.id, input };

      const res = await executeTool(tc.name, input, toolCtx);
      const payload = res.ok ? res.output : { error: res.error };
      const summary = res.ok
        ? `Returned ${JSON.stringify(res.output).length} bytes of JSON.`
        : `Error: ${res.error}`;
      yield { type: "tool_call_result", toolUseId: tc.id, ok: res.ok, summary };

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(payload),
      } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
    }
    // Loop — OpenAI will read the tool messages and respond again.
  }
}
