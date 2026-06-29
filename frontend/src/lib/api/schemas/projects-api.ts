import { z } from "zod";

// ProjectRole — locked to the schema enum (owner | developer | viewer).
export const ProjectRoleApi = z.enum(["owner", "developer", "viewer"]);
export type ProjectRoleApi = z.infer<typeof ProjectRoleApi>;

// Roles allowed to be assigned via API (the owner role is reserved — it's
// granted automatically on project creation and never via invite/PATCH).
export const AssignableRole = z.enum(["developer", "viewer"]);
export type AssignableRole = z.infer<typeof AssignableRole>;

export const ProjectSummary = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  colorHue: z.number().int(),
  health: z.enum(["ok", "warn", "danger"]),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  myRole: ProjectRoleApi,
  // Derived counts the list screens use to render the project card.
  envCount: z.number().int(),
  repoCount: z.number().int(),
  cloud: z.array(z.string()),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const ProjectDetail = ProjectSummary.extend({
  ownerId: z.string(),
  memberCount: z.number().int(),
  pendingInvitations: z.number().int(),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

export const CreateProjectRequest = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(500).default(""),
  colorHue: z.number().int().min(0).max(360).default(285),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const UpdateProjectRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    colorHue: z.number().int().min(0).max(360).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

export const MemberSummary = z.object({
  membershipId: z.string(),
  userId: z.string(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  role: ProjectRoleApi,
  joinedAt: z.string().datetime(),
});
export type MemberSummary = z.infer<typeof MemberSummary>;

export const ChangeRoleRequest = z.object({ role: AssignableRole });
export type ChangeRoleRequest = z.infer<typeof ChangeRoleRequest>;

export const InviteRequest = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  role: AssignableRole.default("developer"),
});
export type InviteRequest = z.infer<typeof InviteRequest>;

export const InvitationSummary = z.object({
  id: z.string(),
  email: z.string().email(),
  role: ProjectRoleApi,
  status: z.enum(["pending", "accepted", "revoked", "expired"]),
  invitedByName: z.string(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type InvitationSummary = z.infer<typeof InvitationSummary>;

export const InvitationPreview = z.object({
  ok: z.literal(true),
  projectName: z.string(),
  projectSlug: z.string(),
  inviterName: z.string(),
  role: ProjectRoleApi,
  invitedEmail: z.string().email(),
  expiresAt: z.string().datetime(),
});
export type InvitationPreview = z.infer<typeof InvitationPreview>;
