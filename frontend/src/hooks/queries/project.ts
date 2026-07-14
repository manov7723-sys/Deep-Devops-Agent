"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  SeedActivity,
  SeedApproval,
  SeedApprovalDetail,
  SeedChatMessage,
  SeedChatSuggestion,
  SeedEnv,
  SeedIssue,
  SeedPipeline,
  SeedProject,
  SeedProjectRepo,
  SeedWorkload,
  SeedCloudProvider,
  SeedCloudResource,
  SeedObservabilityKpi,
  SeedTask,
  SeedKnowledgeDoc,
  SeedAlert,
  SeedIntegration,
  AlertCategory,
  CloudCategory,
  EnvId,
} from "@/lib/legacy-types";
import { costSeed, costExtendedSeed, prometheusSeed, grafanaSeed } from "@/lib/legacy-types";

type ProjectCost = typeof costSeed;
type ProjectCostExtended = ProjectCost & typeof costExtendedSeed;
export type ObservabilityIntegrationProbe = {
  connected: boolean;
  reachable: boolean;
  baseUrl?: string;
  endpoint?: string;
  error?: string;
};

type Observability = {
  kpis: SeedObservabilityKpi[];
  prometheus: typeof prometheusSeed;
  grafana: typeof grafanaSeed;
  integrations?: {
    prometheus: ObservabilityIntegrationProbe;
    grafana: ObservabilityIntegrationProbe;
  };
};

/**
 * Project-scoped query keys use the convention ['p', slug, ...] per DECISIONS.md
 * so a project switch can invalidate everything below it at once.
 */
const pk = (slug: string, ...parts: unknown[]) => ["p", slug, ...parts] as const;

/**
 * Real fields the server returns (superset of legacy `SeedEnv`). Kept inline
 * so the env config screens can read `terraformWorkspace`, `region` etc.
 * without dragging the seed type out of `legacy-types`.
 */
export type ProjectEnv = SeedEnv & {
  key: string;
  isProduction: boolean;
  autoDeploy: boolean;
  region: string | null;
  terraformWorkspace: string | null;
  promotionRank: number;
  cloudProviderId: string | null;
  cloudKind: string | null;
  hasKubeconfig: boolean;
  namespace: string;
  createdAt: string;
  updatedAt: string;
};

export function useProjectEnvs(slug: string) {
  return useQuery({
    queryKey: pk(slug, "envs"),
    queryFn: () => api.get<ProjectEnv[]>(`/projects/${slug}/envs`),
    staleTime: 60_000,
  });
}

export type UpdateEnvPatch = Partial<{
  name: string;
  isProduction: boolean;
  autoDeploy: boolean;
  cloudProviderId: string | null;
  region: string;
  terraformWorkspace: string;
  url: string | null;
  promotionRank: number;
  /** Raw kubeconfig YAML; empty string clears. */
  kubeconfig: string;
  namespace: string;
}>;

export type VerifyClusterResult =
  | {
      ok: true;
      nodes: Array<{ name: string; status: string; version: string }>;
      durationMs: number;
      namespace: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      stderr?: string;
    };

/** POST /projects/[slug]/envs/[key]/verify-cluster — runs `kubectl get nodes`
 *  with the env's stored kubeconfig and returns a parsed node list. */
export function useVerifyCluster(slug: string) {
  return useMutation({
    mutationFn: async (envKey: string): Promise<VerifyClusterResult> => {
      const res = await api.post<VerifyClusterResult>(
        `/projects/${slug}/envs/${envKey}/verify-cluster`,
        {},
      );
      return res;
    },
  });
}

export function useUpdateEnv(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { key: string; patch: UpdateEnvPatch }) => {
      const res = await api.patch<{ ok: boolean; env?: ProjectEnv; message?: string; code?: string }>(
        `/projects/${slug}/envs/${input.key}`,
        input.patch,
      );
      if (!res.ok || !res.env) throw new Error(res.message ?? res.code ?? "Could not update env.");
      return res.env;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pk(slug, "envs") }),
  });
}

export function useDeleteEnv(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => {
      const res = await api.del<{ ok: boolean; message?: string; code?: string }>(
        `/projects/${slug}/envs/${key}`,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not delete env.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pk(slug, "envs") }),
  });
}

export function useProjectWorkloads(slug: string, env: EnvId | "all" = "all") {
  return useQuery({
    queryKey: pk(slug, "workloads", env),
    queryFn: () => api.get<SeedWorkload[]>(`/projects/${slug}/workloads`, { env }),
    staleTime: 30_000,
  });
}

export function useProjectPipelines(slug: string, env: EnvId | "all" = "all") {
  return useQuery({
    queryKey: pk(slug, "pipelines", env),
    queryFn: () => api.get<SeedPipeline[]>(`/projects/${slug}/pipelines`, { env }),
    staleTime: 15_000,
  });
}

export function useProjectApprovals(slug: string) {
  return useQuery({
    queryKey: pk(slug, "approvals"),
    queryFn: () => api.get<SeedApproval[]>(`/projects/${slug}/approvals`),
    staleTime: 15_000,
  });
}

export function useProjectActivity(slug: string) {
  return useQuery({
    queryKey: pk(slug, "activity"),
    queryFn: () => api.get<SeedActivity[]>(`/projects/${slug}/activity`),
    staleTime: 15_000,
  });
}

export function useProjectCost(slug: string) {
  return useQuery({
    queryKey: pk(slug, "cost"),
    queryFn: () => api.get<ProjectCost>(`/projects/${slug}/cost`),
    staleTime: 5 * 60_000,
  });
}

/** Phase 6 — pulls monthly trend + byService alongside the standard fields. */
export function useProjectCostFull(slug: string) {
  return useQuery({
    queryKey: pk(slug, "cost", "full"),
    queryFn: () => api.get<ProjectCostExtended>(`/projects/${slug}/cost`, { detail: "full" }),
    staleTime: 5 * 60_000,
  });
}

export function useProjectRepos(slug: string) {
  return useQuery({
    queryKey: pk(slug, "repos"),
    queryFn: () => api.get<SeedProjectRepo[]>(`/projects/${slug}/repos`),
    staleTime: 60_000,
  });
}

/**
 * DELETE /projects/[slug]/repos/[repoId] — detach a repo from the project.
 * The Repo row itself stays (it might be attached to other projects); only
 * the ProjectRepo join row is removed. Server-side: requires developer+ on
 * the project.
 */
export function useDetachRepo(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (repoId: string) => {
      const res = await api.del<{ ok: boolean; message?: string; code?: string }>(
        `/projects/${slug}/repos/${repoId}`,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not remove repo.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pk(slug, "repos") });
      qc.invalidateQueries({ queryKey: pk(slug) });
    },
  });
}

export function useProjectIssues(slug: string) {
  return useQuery({
    queryKey: pk(slug, "issues"),
    queryFn: () => api.get<SeedIssue[]>(`/projects/${slug}/issues`),
    staleTime: 30_000,
  });
}

export function useChatThread(slug: string) {
  return useQuery({
    queryKey: pk(slug, "chat"),
    queryFn: () => api.get<SeedChatMessage[]>(`/projects/${slug}/chat`),
    staleTime: 5_000,
  });
}

export type ChatThreadSummary = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  messageCount: number;
};

/** List the project's chat threads (newest first) for the history rail. */
export function useChatThreads(slug: string) {
  return useQuery({
    queryKey: pk(slug, "chat", "threads"),
    queryFn: () => api.get<ChatThreadSummary[]>(`/projects/${slug}/chat/threads`),
    staleTime: 5_000,
  });
}

/** Fetch a specific thread's messages when the user clicks it in the rail. */
export function useChatThreadMessages(slug: string, threadId: string | null) {
  return useQuery({
    queryKey: pk(slug, "chat", "threads", threadId ?? "_none"),
    queryFn: () =>
      api.get<SeedChatMessage[]>(`/projects/${slug}/chat/threads/${threadId}/messages`),
    enabled: !!threadId,
    staleTime: 5_000,
  });
}

/** Create a new empty chat thread (New chat button). */
export function useCreateChatThread(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (title?: string) =>
      api.post<{ ok: boolean; threadId: string }>(`/projects/${slug}/chat/threads`, {
        title,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pk(slug, "chat", "threads") });
    },
  });
}

/** Clear the project's chat (deletes threads + messages) and reset the view. */
export function useClearChat(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => api.del<{ ok: boolean }>(`/projects/${slug}/chat`),
    onSuccess: () => {
      qc.setQueryData(pk(slug, "chat"), []);
      qc.invalidateQueries({ queryKey: pk(slug, "chat") });
    },
  });
}

export function useChatSuggestions(slug: string) {
  return useQuery({
    queryKey: pk(slug, "chat", "suggestions"),
    queryFn: () => api.get<SeedChatSuggestion[]>(`/projects/${slug}/chat/suggestions`),
    staleTime: 60_000,
  });
}

export function useSendChatMessage(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      const res = await api.post<{
        ok: boolean;
        thread: SeedChatMessage[];
        agentError?: { code: string; message: string };
      }>(`/projects/${slug}/chat`, { text });
      if (!res.ok) throw new Error("Could not send message.");
      return { thread: res.thread, agentError: res.agentError };
    },
    onMutate: async (text) => {
      await qc.cancelQueries({ queryKey: pk(slug, "chat") });
      const prev = qc.getQueryData<SeedChatMessage[]>(pk(slug, "chat"));
      const optimisticId = `ms_optim_${prev?.length ?? 0}_u`;
      qc.setQueryData<SeedChatMessage[]>(pk(slug, "chat"), [
        ...(prev ?? []),
        { id: optimisticId, role: "user", text },
      ]);
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(pk(slug, "chat"), ctx.prev);
    },
    onSuccess: (result) => qc.setQueryData(pk(slug, "chat"), result.thread),
  });
}

// ----- Phase 6 -----

export function useProjectProviders(slug: string, env: EnvId | "all" = "all") {
  return useQuery({
    queryKey: pk(slug, "providers", env),
    queryFn: () => api.get<SeedCloudProvider[]>(`/projects/${slug}/providers`, { env }),
    staleTime: 60_000,
  });
}

export function useProjectCloud(slug: string, cat: CloudCategory, env: EnvId | "all" = "all") {
  return useQuery({
    queryKey: pk(slug, "cloud", cat, env),
    queryFn: () => api.get<SeedCloudResource[]>(`/projects/${slug}/cloud`, { cat, env }),
    staleTime: 30_000,
  });
}

export function useProjectObservability(slug: string, env: EnvId | "all" = "all") {
  return useQuery({
    queryKey: pk(slug, "observability", env),
    queryFn: () => api.get<Observability>(`/projects/${slug}/observability`, { env }),
    staleTime: 15_000,
  });
}

export function useProjectTasks(slug: string, env: EnvId | "all" = "all") {
  return useQuery({
    queryKey: pk(slug, "tasks", env),
    queryFn: () => api.get<SeedTask[]>(`/projects/${slug}/tasks`, { env }),
    staleTime: 15_000,
  });
}

// ----- Phase 7 -----

export function useKnowledge(slug: string, q: string, env: EnvId | "all" = "all") {
  return useQuery({
    queryKey: pk(slug, "knowledge", q, env),
    queryFn: () => api.get<SeedKnowledgeDoc[]>(`/projects/${slug}/knowledge`, { q, env }),
    staleTime: 30_000,
  });
}

export function useAlerts(slug: string, cat: AlertCategory | "All" = "All") {
  return useQuery({
    queryKey: pk(slug, "alerts", cat),
    queryFn: () => api.get<SeedAlert[]>(`/projects/${slug}/alerts`, { cat }),
    staleTime: 15_000,
  });
}

export function useAlertAction(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; action: "ack" | "resolve" }) => {
      const res = await api.post<{ ok: boolean; alert: SeedAlert }>(
        `/projects/${slug}/alerts/${input.id}`,
        { action: input.action },
      );
      if (!res.ok) throw new Error("Could not update alert.");
      return res.alert;
    },
    onMutate: async ({ id, action }) => {
      const keys = qc.getQueriesData<SeedAlert[]>({ queryKey: pk(slug, "alerts") });
      const snapshots = keys.map(([key, data]) => [key, data] as const);
      for (const [key, data] of snapshots) {
        if (!data) continue;
        qc.setQueryData<SeedAlert[]>(
          key,
          data.map((a) => (a.id === id ? { ...a, status: action === "ack" ? "ack" : "resolved" } : a)),
        );
      }
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      if (ctx) for (const [key, data] of ctx.snapshots) qc.setQueryData(key, data);
    },
  });
}

export function useApprovalDetail(slug: string, id: string | null) {
  return useQuery({
    queryKey: pk(slug, "approvals", id ?? ""),
    queryFn: () =>
      api.get<SeedApproval & SeedApprovalDetail>(`/projects/${slug}/approvals/${id}`),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useApprovalDecision(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; decision: "approve" | "reject" }) => {
      const res = await api.post<{ ok: boolean; id: string; decision: string }>(
        `/projects/${slug}/approvals/${input.id}/decision`,
        { decision: input.decision },
      );
      if (!res.ok) throw new Error("Could not record decision.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pk(slug, "approvals") });
    },
  });
}

export function useIntegrations(slug: string) {
  return useQuery({
    queryKey: pk(slug, "integrations"),
    queryFn: () => api.get<SeedIntegration[]>(`/projects/${slug}/integrations`),
    staleTime: 60_000,
  });
}

/** DELETE /projects/[slug]/integrations/[id] — disconnect one integration. */
export function useDisconnectIntegration(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.del<{ ok: boolean; message?: string; code?: string }>(
        `/projects/${slug}/integrations/${id}`,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not disconnect.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pk(slug, "integrations") }),
  });
}

type ProjectMeta = {
  description: string;
  defaultBranch: string;
  autoDeployNonProd: boolean;
  requireApprovalRelease: boolean;
  defaultModel: string;
};

export function useProjectSettings(slug: string) {
  return useQuery({
    queryKey: pk(slug, "settings"),
    queryFn: () =>
      api.get<{ project: SeedProject; meta: ProjectMeta }>(`/projects/${slug}/settings`),
    staleTime: 60_000,
  });
}

export function useUpdateProjectSettings(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<{
      name: string;
      description: string;
      defaultBranch: string;
      autoDeployNonProd: boolean;
      requireApprovalRelease: boolean;
      defaultModel: string;
      colorHue: number;
    }>) => {
      const res = await api.patch<{ ok: boolean; project: SeedProject; meta: ProjectMeta }>(
        `/projects/${slug}/settings`,
        patch,
      );
      if (!res.ok) throw new Error("Could not save settings.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pk(slug, "settings") });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/** POST /projects/[slug]/archive — sets archivedAt. Owner-only. */
export function useArchiveProject(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<{ ok: boolean; archivedAt?: string; message?: string; code?: string }>(
        `/projects/${slug}/archive`,
        {},
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not archive project.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pk(slug) });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/** DELETE /projects/[slug]/archive — clears archivedAt. Owner-only. */
export function useUnarchiveProject(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.del<{ ok: boolean; message?: string; code?: string }>(
        `/projects/${slug}/archive`,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not unarchive project.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pk(slug) });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/** POST /projects/[slug]/transfer — reassign owner by email. Owner-only. */
export function useTransferProject(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { newOwnerEmail: string; confirmSlug: string }) => {
      const res = await api.post<{
        ok: boolean;
        newOwner?: { id: string; name: string; email: string };
        message?: string;
        code?: string;
      }>(`/projects/${slug}/transfer`, input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not transfer project.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pk(slug) });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/* ─────────────── Members ─────────────── */

export type ProjectMember = {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "owner" | "developer" | "viewer";
  joinedAt: string;
};

export function useProjectMembers(slug: string) {
  return useQuery({
    queryKey: pk(slug, "members"),
    queryFn: () => api.get<ProjectMember[]>(`/projects/${slug}/members`),
    staleTime: 30_000,
  });
}

export function useChangeMemberRole(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; role: "developer" | "viewer" }) => {
      const res = await api.patch<{ ok: boolean; message?: string; code?: string }>(
        `/projects/${slug}/members/${input.userId}`,
        { role: input.role },
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not change role.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pk(slug, "members") }),
  });
}

export function useRemoveMember(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const res = await api.del<{ ok: boolean; message?: string; code?: string }>(
        `/projects/${slug}/members/${userId}`,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not remove member.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pk(slug, "members") }),
  });
}

/* ─────────────── Project-scoped invitations ─────────────── */

export type ProjectInvitation = {
  id: string;
  email: string;
  role: "developer" | "viewer";
  status: "pending" | "accepted" | "revoked" | "expired";
  invitedByName: string;
  expiresAt: string;
  createdAt: string;
};

export function useProjectInvitations(slug: string) {
  return useQuery({
    queryKey: pk(slug, "invitations"),
    queryFn: () => api.get<ProjectInvitation[]>(`/projects/${slug}/invitations`),
    staleTime: 30_000,
  });
}

export function useInviteToProject(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; role: "developer" | "viewer" }) => {
      const res = await api.post<{
        ok: boolean;
        invitationId?: string;
        expiresAt?: string;
        message?: string;
        code?: string;
      }>(`/projects/${slug}/invitations`, input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not send invite.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pk(slug, "invitations") }),
  });
}

export function useRevokeInvitation(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (invitationId: string) => {
      const res = await api.post<{ ok: boolean; message?: string; code?: string }>(
        `/projects/${slug}/invitations/${invitationId}/revoke`,
        {},
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not revoke invite.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pk(slug, "invitations") }),
  });
}

/** DELETE /projects/[slug] — soft-delete. Owner-only. */
export function useDeleteProject(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.del<{ ok: boolean; deletedAt?: string; message?: string; code?: string }>(
        `/projects/${slug}`,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not delete project.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useRunTask(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.post<{ ok: boolean; task: SeedTask }>(`/projects/${slug}/tasks`, { id });
      if (!res.ok) throw new Error("Could not start task.");
      return res.task;
    },
    onMutate: async (id) => {
      // Optimistic flip: any task list under this slug shows the task as running
      const keys = qc.getQueriesData<SeedTask[]>({ queryKey: pk(slug, "tasks") });
      const snapshots = keys.map(([key, data]) => [key, data] as const);
      for (const [key, data] of snapshots) {
        if (!data) continue;
        qc.setQueryData<SeedTask[]>(
          key,
          data.map((t) => (t.id === id ? { ...t, status: "running", progressPct: 5 } : t)),
        );
      }
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      if (ctx) for (const [key, data] of ctx.snapshots) qc.setQueryData(key, data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pk(slug, "tasks") }),
  });
}
