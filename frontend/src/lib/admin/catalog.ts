/**
 * Admin-managed catalogs: Models (LLM), Agents (system prompts + triggers),
 * MCP connectors (per-platform integrations). Models enforce a singleton
 * `isDefault` via transaction. MCP credentials are AES-GCM encrypted.
 */
import type {
  Agent,
  McpAuthType,
  McpConnector,
  McpStatus,
  Model,
  ModelProvider,
} from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { encryptSecret } from "@/lib/auth/crypto";

// ──────────────────────────────────────────────────────────────────
// Models
// ──────────────────────────────────────────────────────────────────

export type ModelRow = {
  id: string;
  name: string;
  provider: ModelProvider;
  ctxTokens: number | null;
  inputCostPerMTokCents: number | null;
  outputCostPerMTokCents: number | null;
  costNote: string | null;
  isDefault: boolean;
  enabled: boolean;
  agentCount: number;
};

function modelRow(m: Model & { _count: { agents: number } }): ModelRow {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    ctxTokens: m.ctxTokens,
    inputCostPerMTokCents: m.inputCostPerMTokCents,
    outputCostPerMTokCents: m.outputCostPerMTokCents,
    costNote: m.costNote,
    isDefault: m.isDefault,
    enabled: m.enabled,
    agentCount: m._count.agents,
  };
}

export async function listModels(): Promise<ModelRow[]> {
  await ensureBuiltinModels();
  const rows = await prisma.model.findMany({
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    include: { _count: { select: { agents: true } } },
  });
  return rows.map(modelRow);
}

/**
 * Display row for the admin Models table (matches `SeedAdminModel`).
 * `ctx` and `cost` are formatted strings; `on` mirrors `enabled`.
 */
export type ModelDisplayRow = {
  id: string;
  name: string;
  provider: string;
  ctx: string;
  cost: string;
  on: boolean;
  isDefault: boolean;
  agentCount: number;
  hasKey: boolean;
};

function formatCtx(tokens: number | null): string {
  if (!tokens) return "—";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return `${tokens}`;
}

function formatCost(inCents: number | null, outCents: number | null, note: string | null): string {
  if (note) return note;
  if (inCents == null && outCents == null) return "—";
  const i = inCents == null ? "—" : `$${(inCents / 100).toFixed(0)}`;
  const o = outCents == null ? "—" : `$${(outCents / 100).toFixed(0)}`;
  return `${i} / ${o} per Mtok`;
}

function providerEnvKey(provider: ModelProvider): string | null {
  if (provider === "Anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "OpenAI") return "OPENAI_API_KEY";
  if (provider === "Groq") return "GROQ_API_KEY";
  if (provider === "Google") return "GOOGLE_API_KEY";
  return null; // SelfHosted has no provider key
}

export async function listModelsDisplay(): Promise<ModelDisplayRow[]> {
  const rows = await listModels();
  return rows.map((m) => {
    const envKey = providerEnvKey(m.provider);
    const hasKey = envKey ? !!process.env[envKey] : true;
    return {
      id: m.id,
      name: m.name,
      provider: m.provider,
      ctx: formatCtx(m.ctxTokens),
      cost: formatCost(m.inputCostPerMTokCents, m.outputCostPerMTokCents, m.costNote),
      on: m.enabled,
      isDefault: m.isDefault,
      agentCount: m.agentCount,
      hasKey,
    };
  });
}

/**
 * Bootstrap the model catalog with industry-standard rows so the admin
 * Models page is never blank. Idempotent — only seeds if the catalog is
 * empty. Admins can delete or disable rows without re-creating them.
 */
const BUILTIN_MODELS: Array<{
  name: string;
  provider: ModelProvider;
  ctxTokens: number;
  inputCostPerMTokCents: number;
  outputCostPerMTokCents: number;
}> = [
  { name: "Claude Sonnet 4.5", provider: "Anthropic", ctxTokens: 200_000, inputCostPerMTokCents: 300, outputCostPerMTokCents: 1500 },
  { name: "Claude Opus 4.7",   provider: "Anthropic", ctxTokens: 200_000, inputCostPerMTokCents: 1500, outputCostPerMTokCents: 7500 },
  { name: "Claude Haiku 4.5",  provider: "Anthropic", ctxTokens: 200_000, inputCostPerMTokCents: 80,  outputCostPerMTokCents: 400 },
  { name: "GPT-4o",            provider: "OpenAI",    ctxTokens: 128_000, inputCostPerMTokCents: 250, outputCostPerMTokCents: 1000 },
  { name: "GPT-4o mini",       provider: "OpenAI",    ctxTokens: 128_000, inputCostPerMTokCents: 15,  outputCostPerMTokCents: 60 },
  { name: "Llama 3.3 70B",     provider: "Groq",      ctxTokens: 128_000, inputCostPerMTokCents: 59,  outputCostPerMTokCents: 79 },
  { name: "Llama 3.1 8B Instant", provider: "Groq",   ctxTokens: 128_000, inputCostPerMTokCents: 5,   outputCostPerMTokCents: 8 },
];

export async function ensureBuiltinModels(): Promise<void> {
  // Gap-fill — any builtin (name, provider) pair not present gets inserted.
  // Existing rows are left untouched so the admin's deletions / enabled
  // toggles persist. Newly-added builtins land on next read.
  const existing = await prisma.model.findMany({
    select: { name: true, provider: true },
  });
  const have = new Set(existing.map((m) => `${m.provider}::${m.name}`));
  const anyDefault = await prisma.model.findFirst({
    where: { isDefault: true },
    select: { id: true },
  });
  for (const m of BUILTIN_MODELS) {
    if (have.has(`${m.provider}::${m.name}`)) continue;
    await prisma.model.create({
      data: {
        name: m.name,
        provider: m.provider,
        ctxTokens: m.ctxTokens,
        inputCostPerMTokCents: m.inputCostPerMTokCents,
        outputCostPerMTokCents: m.outputCostPerMTokCents,
        // Disabled by default — admin enables once the matching env key
        // (ANTHROPIC_API_KEY / OPENAI_API_KEY / GROQ_API_KEY) is in place.
        enabled: false,
        // Make Claude Sonnet 4.5 the platform default if nothing else is.
        isDefault: !anyDefault && m.name === "Claude Sonnet 4.5",
      },
    });
  }
}

export type CreateModelArgs = {
  name: string;
  provider: ModelProvider;
  ctxTokens?: number;
  inputCostPerMTokCents?: number;
  outputCostPerMTokCents?: number;
  costNote?: string;
  enabled: boolean;
  isDefault: boolean;
};

export async function createModel(args: CreateModelArgs): Promise<ModelRow> {
  return prisma.$transaction(async (tx) => {
    if (args.isDefault) {
      await tx.model.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }
    const created = await tx.model.create({
      data: {
        name: args.name,
        provider: args.provider,
        ctxTokens: args.ctxTokens ?? null,
        inputCostPerMTokCents: args.inputCostPerMTokCents ?? null,
        outputCostPerMTokCents: args.outputCostPerMTokCents ?? null,
        costNote: args.costNote ?? null,
        enabled: args.enabled,
        isDefault: args.isDefault,
      },
      include: { _count: { select: { agents: true } } },
    });
    return modelRow(created);
  });
}

export type PatchModelArgs = Partial<{
  name: string;
  ctxTokens: number | null;
  inputCostPerMTokCents: number | null;
  outputCostPerMTokCents: number | null;
  costNote: string | null;
  enabled: boolean;
  isDefault: boolean;
}>;

export type PatchModelResult =
  | { ok: true; model: ModelRow }
  | { ok: false; code: "not_found" };

export async function patchModel(id: string, patch: PatchModelArgs): Promise<PatchModelResult> {
  const existing = await prisma.model.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return { ok: false, code: "not_found" };

  const updated = await prisma.$transaction(async (tx) => {
    if (patch.isDefault === true) {
      await tx.model.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }
    return tx.model.update({
      where: { id },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.ctxTokens !== undefined && { ctxTokens: patch.ctxTokens }),
        ...(patch.inputCostPerMTokCents !== undefined && { inputCostPerMTokCents: patch.inputCostPerMTokCents }),
        ...(patch.outputCostPerMTokCents !== undefined && { outputCostPerMTokCents: patch.outputCostPerMTokCents }),
        ...(patch.costNote !== undefined && { costNote: patch.costNote }),
        ...(patch.enabled !== undefined && { enabled: patch.enabled }),
        ...(patch.isDefault !== undefined && { isDefault: patch.isDefault }),
      },
      include: { _count: { select: { agents: true } } },
    });
  });
  return { ok: true, model: modelRow(updated) };
}

export type DeleteModelResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "in_use" };

export async function deleteModel(id: string): Promise<DeleteModelResult> {
  const m = await prisma.model.findUnique({
    where: { id },
    include: { _count: { select: { agents: true, projectDefault: true, chatMessages: true } } },
  });
  if (!m) return { ok: false, code: "not_found" };
  if (m._count.agents > 0 || m._count.projectDefault > 0 || m._count.chatMessages > 0) {
    return { ok: false, code: "in_use" };
  }
  await prisma.model.delete({ where: { id } });
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────
// Agents
// ──────────────────────────────────────────────────────────────────

export type AgentRow = {
  id: string;
  name: string;
  skill: string;
  triggerDescription: string;
  approvalPolicy: string;
  modelId: string | null;
  modelName: string | null;
  enabled: boolean;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
};

function agentRow(a: Agent & { model: { name: string } | null }): AgentRow {
  return {
    id: a.id,
    name: a.name,
    skill: a.skill,
    triggerDescription: a.triggerDescription,
    approvalPolicy: a.approvalPolicy,
    modelId: a.modelId,
    modelName: a.model?.name ?? null,
    enabled: a.enabled,
    systemPrompt: a.systemPrompt,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export async function listAgents(): Promise<AgentRow[]> {
  const rows = await prisma.agent.findMany({
    orderBy: { name: "asc" },
    include: { model: { select: { name: true } } },
  });
  return rows.map(agentRow);
}

export type CreateAgentArgs = {
  name: string;
  skill: string;
  triggerDescription: string;
  approvalPolicy: string;
  modelId?: string;
  enabled: boolean;
  systemPrompt: string;
};

export type CreateAgentResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; code: "model_not_found" };

export async function createAgent(args: CreateAgentArgs): Promise<CreateAgentResult> {
  if (args.modelId) {
    const m = await prisma.model.findUnique({ where: { id: args.modelId }, select: { id: true } });
    if (!m) return { ok: false, code: "model_not_found" };
  }
  const created = await prisma.agent.create({
    data: {
      name: args.name,
      skill: args.skill,
      triggerDescription: args.triggerDescription,
      approvalPolicy: args.approvalPolicy,
      modelId: args.modelId ?? null,
      enabled: args.enabled,
      systemPrompt: args.systemPrompt,
    },
    include: { model: { select: { name: true } } },
  });
  return { ok: true, agent: agentRow(created) };
}

export type PatchAgentArgs = Partial<{
  name: string;
  skill: string;
  triggerDescription: string;
  approvalPolicy: string;
  modelId: string | null;
  enabled: boolean;
  systemPrompt: string;
}>;

export type PatchAgentResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; code: "not_found" | "model_not_found" };

export async function patchAgent(id: string, patch: PatchAgentArgs): Promise<PatchAgentResult> {
  const existing = await prisma.agent.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return { ok: false, code: "not_found" };
  if (patch.modelId) {
    const m = await prisma.model.findUnique({ where: { id: patch.modelId }, select: { id: true } });
    if (!m) return { ok: false, code: "model_not_found" };
  }
  const updated = await prisma.agent.update({
    where: { id },
    data: {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.skill !== undefined && { skill: patch.skill }),
      ...(patch.triggerDescription !== undefined && { triggerDescription: patch.triggerDescription }),
      ...(patch.approvalPolicy !== undefined && { approvalPolicy: patch.approvalPolicy }),
      ...(patch.modelId !== undefined && { modelId: patch.modelId }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      ...(patch.systemPrompt !== undefined && { systemPrompt: patch.systemPrompt }),
    },
    include: { model: { select: { name: true } } },
  });
  return { ok: true, agent: agentRow(updated) };
}

export type DeleteAgentResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "in_use" };

export async function deleteAgent(id: string): Promise<DeleteAgentResult> {
  const a = await prisma.agent.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          approvals: true,
          activities: true,
          alerts: true,
          tasks: true,
          pipelines: true,
          issues: true,
          deployments: true,
          chatMessages: true,
        },
      },
    },
  });
  if (!a) return { ok: false, code: "not_found" };
  const totalRefs = Object.values(a._count).reduce((sum, n) => sum + n, 0);
  if (totalRefs > 0) return { ok: false, code: "in_use" };
  await prisma.agent.delete({ where: { id } });
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────
// MCP connectors
// ──────────────────────────────────────────────────────────────────

export type McpRow = {
  id: string;
  name: string;
  description: string;
  status: McpStatus;
  authType: McpAuthType;
  avgCallsPerDay: number | null;
  avgLatencyMs: number | null;
  credentialKeys: Array<{ key: string; isSecret: boolean }>;
  createdAt: string;
};

function mcpRow(
  c: McpConnector & { credentials: Array<{ key: string; isSecret: boolean }> },
): McpRow {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    status: c.status,
    authType: c.authType,
    avgCallsPerDay: c.avgCallsPerDay,
    avgLatencyMs: c.avgLatencyMs,
    credentialKeys: c.credentials.map((cr) => ({ key: cr.key, isSecret: cr.isSecret })),
    createdAt: c.createdAt.toISOString(),
  };
}

export async function listMcp(): Promise<McpRow[]> {
  const rows = await prisma.mcpConnector.findMany({
    orderBy: { name: "asc" },
    include: { credentials: { select: { key: true, isSecret: true } } },
  });
  return rows.map(mcpRow);
}

export type CreateMcpArgs = {
  name: string;
  description: string;
  authType: McpAuthType;
  status: McpStatus;
  avgCallsPerDay?: number;
  avgLatencyMs?: number;
};

export async function createMcp(args: CreateMcpArgs): Promise<McpRow> {
  const created = await prisma.mcpConnector.create({
    data: {
      name: args.name,
      description: args.description,
      authType: args.authType,
      status: args.status,
      avgCallsPerDay: args.avgCallsPerDay ?? null,
      avgLatencyMs: args.avgLatencyMs ?? null,
    },
    include: { credentials: { select: { key: true, isSecret: true } } },
  });
  return mcpRow(created);
}

export type PatchMcpArgs = Partial<{
  name: string;
  description: string;
  authType: McpAuthType;
  status: McpStatus;
  avgCallsPerDay: number | null;
  avgLatencyMs: number | null;
}>;

export type PatchMcpResult =
  | { ok: true; connector: McpRow }
  | { ok: false; code: "not_found" };

export async function patchMcp(id: string, patch: PatchMcpArgs): Promise<PatchMcpResult> {
  const existing = await prisma.mcpConnector.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return { ok: false, code: "not_found" };
  const updated = await prisma.mcpConnector.update({
    where: { id },
    data: {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.authType !== undefined && { authType: patch.authType }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.avgCallsPerDay !== undefined && { avgCallsPerDay: patch.avgCallsPerDay }),
      ...(patch.avgLatencyMs !== undefined && { avgLatencyMs: patch.avgLatencyMs }),
    },
    include: { credentials: { select: { key: true, isSecret: true } } },
  });
  return { ok: true, connector: mcpRow(updated) };
}

export type DeleteMcpResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "in_use" };

export async function deleteMcp(id: string): Promise<DeleteMcpResult> {
  const c = await prisma.mcpConnector.findUnique({
    where: { id },
    include: { _count: { select: { projectConnections: true } } },
  });
  if (!c) return { ok: false, code: "not_found" };
  if (c._count.projectConnections > 0) return { ok: false, code: "in_use" };
  await prisma.mcpConnector.delete({ where: { id } });
  return { ok: true };
}

export type UpsertCredentialResult =
  | { ok: true }
  | { ok: false; code: "not_found" };

export async function upsertMcpCredential(
  connectorId: string,
  key: string,
  value: string,
  isSecret: boolean,
): Promise<UpsertCredentialResult> {
  const c = await prisma.mcpConnector.findUnique({ where: { id: connectorId }, select: { id: true } });
  if (!c) return { ok: false, code: "not_found" };
  await prisma.mcpCredential.upsert({
    where: { connectorId_key: { connectorId, key } },
    create: { connectorId, key, valueRef: encryptSecret(value), isSecret },
    update: { valueRef: encryptSecret(value), isSecret },
  });
  return { ok: true };
}
