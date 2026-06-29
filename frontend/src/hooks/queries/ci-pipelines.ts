import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

export type CiFile = { path: string; content: string };

export type CiStageStep = { name: string; status: string; conclusion: string | null };
export type CiStage = { name: string; status: string; conclusion: string | null; steps: CiStageStep[] };

export type CiPipelineRow = {
  id: string;
  name: string;
  status: string;
  agentReview: boolean;
  branch: string;
  runUrl: string | null;
  conclusion: string | null;
  lastError: string | null;
  healAttempts: number;
  repoFullName: string;
  updatedAt: string;
  createdAt: string;
};

export type CiPipelineDetail = {
  id: string;
  name: string;
  status: string;
  agentReview: boolean;
  branch: string;
  files: CiFile[];
  workflowPath: string | null;
  runUrl: string | null;
  conclusion: string | null;
  stages: CiStage[] | null;
  lastError: string | null;
  healAttempts: number;
  updatedAt: string;
};

export type CiPipelineStatus = {
  status: string;
  agentReview: boolean;
  healAttempts: number;
  maxHealAttempts: number;
  runUrl: string | null;
  conclusion: string | null;
  stages: CiStage[];
  lastError: string | null;
  healing: boolean;
  healNote?: string | null;
};

const listKey = (slug: string) => ["p", slug, "ci-pipelines"] as const;
const oneKey = (slug: string, id: string) => ["p", slug, "ci-pipeline", id] as const;
const statusKey = (slug: string, id: string) => ["p", slug, "ci-pipeline-status", id] as const;

export function useCiPipelines(slug: string) {
  return useQuery({
    queryKey: listKey(slug),
    queryFn: () => api.get<CiPipelineRow[]>(`/projects/${slug}/ci-pipelines`),
    staleTime: 15_000,
  });
}

export function useCiPipeline(slug: string, id: string | null) {
  return useQuery({
    queryKey: oneKey(slug, id ?? ""),
    queryFn: () => api.get<CiPipelineDetail>(`/projects/${slug}/ci-pipelines/${id}`),
    enabled: !!id,
  });
}

export function useUpdateCiPipeline(slug: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; files?: CiFile[]; agentReview?: boolean }) =>
      api.patch<{ ok: boolean }>(`/projects/${slug}/ci-pipelines/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: oneKey(slug, id) });
      qc.invalidateQueries({ queryKey: listKey(slug) });
    },
  });
}

export function useRunCiPipeline(slug: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<{ ok: boolean; message?: string; code?: string; runUrl?: string | null }>(
        `/projects/${slug}/ci-pipelines/${id}/run`,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not run the pipeline.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKey(slug) });
      qc.invalidateQueries({ queryKey: statusKey(slug, id) });
    },
  });
}

export function useDeleteCiPipeline(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/projects/${slug}/ci-pipelines/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(slug) }),
  });
}

/** Polls run status while the pipeline is running (drives the live view). */
export function useCiPipelineStatus(slug: string, id: string | null, live: boolean) {
  return useQuery({
    queryKey: statusKey(slug, id ?? ""),
    queryFn: () => api.get<CiPipelineStatus>(`/projects/${slug}/ci-pipelines/${id}/status`),
    enabled: !!id,
    refetchInterval: live ? 5000 : false,
  });
}
