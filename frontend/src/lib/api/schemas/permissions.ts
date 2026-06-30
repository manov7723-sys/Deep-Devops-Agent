/**
 * Per-project RBAC matrix. Mirrors DECISIONS.md.
 *
 * Roles: owner | contributor | member
 * - owner: everything (only role that can delete a project)
 * - contributor: equal to owner EXCEPT delete project
 * - member: read + run pipelines only
 *
 * Super-admin is a flag on User (not a project role).
 */
import type { ProjectRole } from "./user";

export const PROJECT_ACTIONS = [
  "view",
  "runPipeline",
  "approveApproval",
  "editEnvVars",
  "manageCloudProviders",
  "inviteMember",
  "editSettings",
  "deleteProject",
] as const;

export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export const PROJECT_PERMISSIONS: Record<ProjectRole, Record<ProjectAction, boolean>> = {
  owner: {
    view: true,
    runPipeline: true,
    approveApproval: true,
    editEnvVars: true,
    manageCloudProviders: true,
    inviteMember: true,
    editSettings: true,
    deleteProject: true,
  },
  contributor: {
    view: true,
    runPipeline: true,
    approveApproval: true,
    editEnvVars: true,
    manageCloudProviders: true,
    inviteMember: true,
    editSettings: true,
    deleteProject: false,
  },
  member: {
    view: true,
    runPipeline: true,
    approveApproval: false,
    editEnvVars: false,
    manageCloudProviders: false,
    inviteMember: false,
    editSettings: false,
    deleteProject: false,
  },
};

export function can(role: ProjectRole, action: ProjectAction): boolean {
  return PROJECT_PERMISSIONS[role]?.[action] ?? false;
}
