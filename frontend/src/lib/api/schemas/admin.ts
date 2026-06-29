import { z } from "zod";

export const AdminPlanTier = z.enum(["Free", "Pro", "Scale", "Enterprise"]);

export const AdminUser = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  plan: AdminPlanTier,
  projects: z.number().int(),
  status: z.enum(["active", "trial", "past_due", "suspended"]),
  joined: z.string(),
  spend: z.string(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const AdminSubscription = z.object({
  id: z.string(),
  userName: z.string(),
  email: z.string().email(),
  plan: AdminPlanTier,
  base: z.number(),
  status: z.enum(["active", "trial", "past_due", "suspended"]),
  renews: z.string(),
  method: z.string(),
  addons: z.array(
    z.object({ name: z.string(), price: z.number(), icon: z.string() }),
  ),
});
export type AdminSubscription = z.infer<typeof AdminSubscription>;

export const McpConnector = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(["ok", "warn", "down"]),
  callsPerDay: z.string(),
  latency: z.string(),
});
export type McpConnector = z.infer<typeof McpConnector>;

export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  skill: z.string(),
  trigger: z.string(),
  approvals: z.string(),
  model: z.string(),
  on: z.boolean(),
  prompt: z.string(),
});
export type Agent = z.infer<typeof Agent>;

export const AdminModel = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.enum(["Anthropic", "OpenAI", "Self-hosted", "Google"]),
  ctx: z.string(),
  cost: z.string(),
  isDefault: z.boolean(),
  on: z.boolean(),
});
export type AdminModel = z.infer<typeof AdminModel>;
