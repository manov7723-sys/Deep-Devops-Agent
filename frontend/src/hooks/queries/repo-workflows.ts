import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

export type RepoWorkflow = { id: number; name: string; path: string };

type WorkflowsResponse = { ok: boolean; defaultBranch: string; workflows: RepoWorkflow[] };

/** Every GitHub Actions workflow GitHub already knows about for this repo — not just ones DeepAgent generated. */
export function useRepoWorkflows(slug: string, repoId: string | null) {
  return useQuery({
    queryKey: ["p", slug, "repo", repoId, "workflows"],
    queryFn: () => api.get<WorkflowsResponse>(`/projects/${slug}/repos/${repoId}/workflows`),
    enabled: !!repoId,
    staleTime: 15_000,
  });
}

type DispatchResponse = {
  ok: boolean;
  runId?: string | null;
  runUrl?: string | null;
  message?: string;
  code?: string;
};

/** Trigger any workflow found in the repo directly — no commit, no CiPipeline row required. */
export function useDispatchWorkflow(slug: string, repoId: string | null) {
  return useMutation({
    mutationFn: async (workflowId: number) => {
      const res = await api.post<DispatchResponse>(
        `/projects/${slug}/repos/${repoId}/workflows/${workflowId}/dispatch`,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not trigger the workflow.");
      return res;
    },
  });
}
