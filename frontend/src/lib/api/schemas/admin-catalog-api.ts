import { z } from "zod";

// ──────────────────────────────────────────────────────────────────
// Models (LLM catalog)
// ──────────────────────────────────────────────────────────────────
// Prisma enum uses `SelfHosted` with @map("Self-hosted") — keep client values
// in line with the Prisma TS enum so we don't need a mapping layer.
export const ModelProviderApi = z.enum(["Anthropic", "OpenAI", "Groq", "SelfHosted", "Google"]);
export type ModelProviderApi = z.infer<typeof ModelProviderApi>;

export const ModelSummary = z.object({
  id: z.string(),
  name: z.string(),
  provider: ModelProviderApi,
  ctxTokens: z.number().int().nullable(),
  inputCostPerMTokCents: z.number().int().nullable(),
  outputCostPerMTokCents: z.number().int().nullable(),
  costNote: z.string().nullable(),
  isDefault: z.boolean(),
  enabled: z.boolean(),
  agentCount: z.number().int(),
});
export type ModelSummary = z.infer<typeof ModelSummary>;

export const CreateModelRequest = z.object({
  name: z.string().trim().min(1).max(80),
  provider: ModelProviderApi,
  ctxTokens: z.number().int().min(1).optional(),
  inputCostPerMTokCents: z.number().int().min(0).optional(),
  outputCostPerMTokCents: z.number().int().min(0).optional(),
  costNote: z.string().trim().max(120).optional(),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});
export type CreateModelRequest = z.infer<typeof CreateModelRequest>;

export const PatchModelRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    ctxTokens: z.number().int().min(1).nullable().optional(),
    inputCostPerMTokCents: z.number().int().min(0).nullable().optional(),
    outputCostPerMTokCents: z.number().int().min(0).nullable().optional(),
    costNote: z.string().trim().max(120).nullable().optional(),
    enabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });
export type PatchModelRequest = z.infer<typeof PatchModelRequest>;

// ──────────────────────────────────────────────────────────────────
// Agents
// ──────────────────────────────────────────────────────────────────
export const AgentSummary = z.object({
  id: z.string(),
  name: z.string(),
  skill: z.string(),
  triggerDescription: z.string(),
  approvalPolicy: z.string(),
  modelId: z.string().nullable(),
  modelName: z.string().nullable(),
  enabled: z.boolean(),
  systemPrompt: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentSummary = z.infer<typeof AgentSummary>;

export const CreateAgentRequest = z.object({
  name: z.string().trim().min(1).max(80),
  skill: z.string().trim().min(1).max(80),
  triggerDescription: z.string().trim().min(1).max(160),
  approvalPolicy: z.string().trim().min(1).max(160),
  modelId: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  systemPrompt: z.string().trim().min(1).max(8000),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequest>;

export const PatchAgentRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    skill: z.string().trim().min(1).max(80).optional(),
    triggerDescription: z.string().trim().min(1).max(160).optional(),
    approvalPolicy: z.string().trim().min(1).max(160).optional(),
    modelId: z.string().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
    systemPrompt: z.string().trim().min(1).max(8000).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });
export type PatchAgentRequest = z.infer<typeof PatchAgentRequest>;

// ──────────────────────────────────────────────────────────────────
// MCP connectors
// ──────────────────────────────────────────────────────────────────
export const McpAuthTypeApi = z.enum(["none", "oauth", "credential"]);
export const McpStatusApi = z.enum(["ok", "warn", "down"]);

export const McpSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: McpStatusApi,
  authType: McpAuthTypeApi,
  avgCallsPerDay: z.number().int().nullable(),
  avgLatencyMs: z.number().int().nullable(),
  credentialKeys: z.array(z.object({ key: z.string(), isSecret: z.boolean() })),
  createdAt: z.string().datetime(),
});
export type McpSummary = z.infer<typeof McpSummary>;

export const CreateMcpRequest = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(280),
  authType: McpAuthTypeApi.default("none"),
  status: McpStatusApi.default("ok"),
  avgCallsPerDay: z.number().int().min(0).optional(),
  avgLatencyMs: z.number().int().min(0).optional(),
});
export type CreateMcpRequest = z.infer<typeof CreateMcpRequest>;

export const PatchMcpRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().min(1).max(280).optional(),
    authType: McpAuthTypeApi.optional(),
    status: McpStatusApi.optional(),
    avgCallsPerDay: z.number().int().min(0).nullable().optional(),
    avgLatencyMs: z.number().int().min(0).nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });
export type PatchMcpRequest = z.infer<typeof PatchMcpRequest>;

export const UpsertMcpCredentialRequest = z.object({
  key: z.string().trim().min(1).max(60),
  value: z.string().min(1),
  isSecret: z.boolean().optional().default(true),
});
export type UpsertMcpCredentialRequest = z.infer<typeof UpsertMcpCredentialRequest>;
