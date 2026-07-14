import { z } from "zod";
import { Tone, EnvId } from "./common";

/**
 * Project — the URL-keyed entity. Phase 11 Prisma schema is derived from this.
 */
export const Project = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  colorHue: z.number(),
  envs: z.number().int(),
  repos: z.number().int(),
  description: z.string(),
  health: z.enum(["ok", "warn", "danger"]),
  cloud: z.array(z.string()),
});
export type Project = z.infer<typeof Project>;

export const Env = z.object({
  id: EnvId,
  name: z.string(),
  branch: z.string(),
  url: z.string(),
  tone: z.enum(["info", "warn", "ok"]),
  auto: z.boolean(),
});
export type Env = z.infer<typeof Env>;

export const Workload = z.object({
  id: z.string(),
  name: z.string(),
  env: EnvId,
  replicas: z.string(),
  cpu: z.string(),
  mem: z.string(),
  status: z.enum(["ok", "warn", "danger"]),
});
export type Workload = z.infer<typeof Workload>;

export const PipelineStage = z.object({
  label: z.string(),
  status: z.enum(["ok", "fail", "run", "wait"]),
});
export type PipelineStage = z.infer<typeof PipelineStage>;

export const Pipeline = z.object({
  id: z.string(),
  repo: z.string(),
  env: EnvId,
  branch: z.string(),
  sha: z.string(),
  who: z.string(),
  status: z.enum(["ok", "running", "failed"]),
  startedRelative: z.string(),
  duration: z.string(),
  progressPct: z.number().min(0).max(100),
  stages: z.array(PipelineStage),
});
export type Pipeline = z.infer<typeof Pipeline>;

export const Approval = z.object({
  id: z.string(),
  title: z.string(),
  env: EnvId,
  agent: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  requestedRelative: z.string(),
});
export type Approval = z.infer<typeof Approval>;

export const Activity = z.object({
  id: z.string(),
  who: z.string(),
  act: z.string(),
  target: z.string(),
  env: z.union([EnvId, z.literal("shared")]),
  icon: z.string(),
  timeRelative: z.string(),
});
export type Activity = z.infer<typeof Activity>;

export const Alert = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  resource: z.string(),
  source: z.string(),
  env: EnvId,
  cat: z.enum(["Security", "Performance", "Compliance", "Reliability"]),
  sev: z.enum(["low", "medium", "high"]),
  when: z.string(),
  recommendation: z.string(),
  status: z.enum(["open", "ack", "resolved"]),
});
export type Alert = z.infer<typeof Alert>;

export const ProjectCost = z.object({
  monthTotal: z.number(),
  byEnv: z.array(z.object({ name: z.string(), value: z.number(), color: z.string() })),
  forecast: z.string(),
  budget: z.number(),
});
export type ProjectCost = z.infer<typeof ProjectCost>;

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  agent: z.string(),
  env: z.union([EnvId, z.literal("all")]),
  icon: z.string(),
  schedule: z.string(),
  lastRun: z.string(),
  status: z.enum(["ok", "warn", "running"]),
  findings: z.string(),
  // Nullable in Postgres, optional in the in-memory mock. Both shapes pass.
  progressPct: z.number().nullable().optional(),
});
export type Task = z.infer<typeof Task>;

// Re-export Tone for callers
export { Tone };
