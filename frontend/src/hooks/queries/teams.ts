"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type { SeedTeamMember } from "@/lib/legacy-types";

export type ProjectRoleApi = "owner" | "developer" | "viewer";

export type TeamMemberSharedProject = {
  id: string;
  slug: string;
  name: string;
  memberRole: ProjectRoleApi;
  /** Caller's role in that shared project — drives whether the Remove
   *  affordance is enabled per-project in the UI. */
  myRole: ProjectRoleApi;
};

export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: ProjectRoleApi;
  projects: number;
  lastActive: string;
  invitedAt: string;
  joinedAt: string;
  sharedProjects: TeamMemberSharedProject[];
};

// Re-export the legacy type for backward-compat for any consumer that still
// reads `SeedTeamMember` from this module.
export type { SeedTeamMember };

const TEAMS_KEY = ["teams"] as const;
const TEAM_INVITES_KEY = ["teams", "invitations"] as const;

export function useTeams() {
  return useQuery({
    queryKey: TEAMS_KEY,
    queryFn: () => api.get<TeamMember[]>("/teams"),
    staleTime: 30_000,
  });
}

// SeedTeamMember is unused below but kept above for legacy callers.
void ({} as SeedTeamMember | undefined);

export function useInviteMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; role: "developer" | "viewer"; projectIds: string[] }) => {
      const res = await api.post<{ ok: boolean; member?: TeamMember; message?: string; code?: string }>(
        "/teams",
        input,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not send invite.");
      return res.member;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TEAMS_KEY });
      qc.invalidateQueries({ queryKey: TEAM_INVITES_KEY });
    },
  });
}

/* ─────────────── Aggregated pending invitations ─────────────── */

export type TeamPendingInvitation = {
  id: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  email: string;
  role: ProjectRoleApi;
  status: "pending" | "accepted" | "revoked" | "expired";
  invitedByName: string;
  expiresAt: string;
  createdAt: string;
};

export function useTeamPendingInvitations() {
  return useQuery({
    queryKey: TEAM_INVITES_KEY,
    queryFn: () => api.get<TeamPendingInvitation[]>("/teams/invitations"),
    staleTime: 30_000,
  });
}

/** POST /projects/[slug]/invitations/[id]/resend — re-issue magic link + re-email. */
export function useResendInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { projectSlug: string; invitationId: string }) => {
      const res = await api.post<{ ok: boolean; expiresAt?: string; message?: string; code?: string }>(
        `/projects/${input.projectSlug}/invitations/${input.invitationId}/resend`,
        {},
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not resend invitation.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TEAM_INVITES_KEY });
    },
  });
}

/** POST /projects/[slug]/invitations/[id]/revoke — revoke a pending invite. */
export function useRevokePendingInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { projectSlug: string; invitationId: string }) => {
      const res = await api.post<{ ok: boolean; message?: string; code?: string }>(
        `/projects/${input.projectSlug}/invitations/${input.invitationId}/revoke`,
        {},
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not revoke.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: TEAM_INVITES_KEY }),
  });
}

/** DELETE /projects/[slug]/members/[userId] — remove a member from one project. */
export function useRemoveMemberFromProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { projectSlug: string; userId: string }) => {
      const res = await api.del<{ ok: boolean; message?: string; code?: string }>(
        `/projects/${input.projectSlug}/members/${input.userId}`,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not remove member.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TEAMS_KEY });
    },
  });
}
