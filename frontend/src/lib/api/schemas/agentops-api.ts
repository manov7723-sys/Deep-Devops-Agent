import { z } from "zod";

// ──────────────────────────────────────────────────────────────────
// Alerts
// ──────────────────────────────────────────────────────────────────
export const AlertCategoryApi = z.enum(["Security", "Performance", "Compliance", "Reliability"]);
export const AlertSeverityApi = z.enum(["low", "medium", "high"]);
export const AlertStatusApi = z.enum(["open", "ack", "resolved"]);

export const AlertSummary = z.object({
  id: z.string(),
  envKey: z.string(),
  title: z.string(),
  detail: z.string(),
  resource: z.string(),
  source: z.string(),
  category: AlertCategoryApi,
  severity: AlertSeverityApi,
  recommendation: z.string(),
  status: AlertStatusApi,
  detectedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
});
export type AlertSummary = z.infer<typeof AlertSummary>;

export const CreateAlertRequest = z.object({
  envKey: z.string().trim().min(1),
  title: z.string().trim().min(1).max(140),
  detail: z.string().trim().min(1).max(500),
  resource: z.string().trim().min(1).max(140),
  sourceLabel: z.string().trim().max(80).optional(),
  category: AlertCategoryApi,
  severity: AlertSeverityApi,
  recommendation: z.string().trim().min(1).max(500),
});
export type CreateAlertRequest = z.infer<typeof CreateAlertRequest>;

export const PatchAlertRequest = z.object({
  status: z.enum(["ack", "resolved"]),
});
export type PatchAlertRequest = z.infer<typeof PatchAlertRequest>;

// ──────────────────────────────────────────────────────────────────
// Activity
// ──────────────────────────────────────────────────────────────────
export const ActivityRow = z.object({
  id: z.string(),
  envKey: z.string().nullable(),
  actorName: z.string(),
  actorKind: z.enum(["user", "agent", "system"]),
  action: z.string(),
  targetLabel: z.string(),
  targetType: z.string().nullable(),
  icon: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type ActivityRow = z.infer<typeof ActivityRow>;

export const CreateActivityRequest = z.object({
  envKey: z.string().trim().min(1).optional(),
  action: z.string().trim().min(1).max(40),
  targetLabel: z.string().trim().min(1).max(140),
  targetType: z.string().trim().max(40).optional(),
  icon: z.string().trim().max(40).optional(),
});
export type CreateActivityRequest = z.infer<typeof CreateActivityRequest>;

// ──────────────────────────────────────────────────────────────────
// Tasks (scheduled agent runs)
// ──────────────────────────────────────────────────────────────────
export const TaskStatusApi = z.enum(["ok", "warn", "running"]);

export const TaskSummary = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string(),
  agentId: z.string().nullable(),
  envKey: z.string().nullable(),
  allEnvs: z.boolean(),
  schedule: z.string(),
  lastRunAt: z.string().datetime().nullable(),
  nextRunAt: z.string().datetime().nullable(),
  status: TaskStatusApi,
  findingsSummary: z.string().nullable(),
  progressPct: z.number().int().nullable(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const CreateTaskRequest = z.object({
  title: z.string().trim().min(1).max(140),
  icon: z.string().trim().min(1).max(40),
  schedule: z.string().trim().min(1).max(120),
  envKey: z.string().trim().min(1).optional(),
  allEnvs: z.boolean().default(false),
  agentId: z.string().trim().min(1).optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const PatchTaskRequest = z
  .object({
    title: z.string().trim().min(1).max(140).optional(),
    schedule: z.string().trim().min(1).max(120).optional(),
    status: TaskStatusApi.optional(),
    findingsSummary: z.string().trim().max(500).nullable().optional(),
    progressPct: z.number().int().min(0).max(100).nullable().optional(),
    nextRunAt: z.string().datetime().nullable().optional(),
    lastRunAt: z.string().datetime().nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });
export type PatchTaskRequest = z.infer<typeof PatchTaskRequest>;

// ──────────────────────────────────────────────────────────────────
// Knowledge base — written docs only this phase
// ──────────────────────────────────────────────────────────────────
export const KnowledgeTypeApi = z.enum(["Doc", "Runbook"]);

export const KnowledgeSummary = z.object({
  id: z.string(),
  title: z.string(),
  excerpt: z.string(),
  type: KnowledgeTypeApi,
  tags: z.array(z.string()),
  envKey: z.string().nullable(),
  authorName: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type KnowledgeSummary = z.infer<typeof KnowledgeSummary>;

export const KnowledgeDetail = KnowledgeSummary.extend({
  body: z.string().nullable(),
});
export type KnowledgeDetail = z.infer<typeof KnowledgeDetail>;

export const CreateKnowledgeRequest = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1),
  type: KnowledgeTypeApi.default("Doc"),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  envKey: z.string().trim().min(1).optional(),
  excerpt: z.string().trim().max(280).optional(),
});
export type CreateKnowledgeRequest = z.infer<typeof CreateKnowledgeRequest>;

export const PatchKnowledgeRequest = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    body: z.string().trim().min(1).optional(),
    type: KnowledgeTypeApi.optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    excerpt: z.string().trim().max(280).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });
export type PatchKnowledgeRequest = z.infer<typeof PatchKnowledgeRequest>;

// ──────────────────────────────────────────────────────────────────
// Chat
// ──────────────────────────────────────────────────────────────────
export const ChatRoleApi = z.enum(["user", "agent"]);

export const ChatMessageRow = z.object({
  id: z.string(),
  role: ChatRoleApi,
  authorName: z.string().nullable(),
  text: z.string(),
  codeBody: z.string().nullable(),
  codeLang: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  createdAt: z.string().datetime(),
});
export type ChatMessageRow = z.infer<typeof ChatMessageRow>;

export const ChatThreadSummary = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastMessageAt: z.string().datetime().nullable(),
  messageCount: z.number().int(),
});
export type ChatThreadSummary = z.infer<typeof ChatThreadSummary>;

export const ChatThreadDetail = z.object({
  thread: ChatThreadSummary,
  messages: z.array(ChatMessageRow),
});
export type ChatThreadDetail = z.infer<typeof ChatThreadDetail>;

export const CreateThreadRequest = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  firstMessage: z.string().trim().min(1).max(4000).optional(),
});
export type CreateThreadRequest = z.infer<typeof CreateThreadRequest>;

export const PostMessageRequest = z.object({
  text: z.string().trim().min(1).max(4000),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;
