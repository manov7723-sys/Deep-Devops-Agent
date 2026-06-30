import { z } from "zod";

export const ProjectRole = z.enum(["owner", "contributor", "member"]);
export type ProjectRole = z.infer<typeof ProjectRole>;

export const User = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  avatarUrl: z.string().nullable().optional(),
  jobTitle: z.string().optional(),
  timezone: z.string().optional(),
  isSuperAdmin: z.boolean().default(false),
  twoFactorEnabled: z.boolean().default(false),
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof User>;

export const TeamMember = z.object({
  id: z.string(),
  userId: z.string(),
  projectId: z.string(),
  name: z.string(),
  email: z.string().email(),
  role: ProjectRole,
  invitedAt: z.string().datetime(),
  joinedAt: z.string().datetime().nullable(),
});
export type TeamMember = z.infer<typeof TeamMember>;
