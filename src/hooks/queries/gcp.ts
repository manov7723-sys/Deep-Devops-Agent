import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

export type GcpContext = {
  ok: boolean;
  connected: boolean;
  gcpProjectId?: string;
  region?: string;
  projects?: Array<{ projectId: string; name: string; lifecycleState: string }>;
  authError?: string | null;
};

const key = (slug: string) => ["p", slug, "gcp-context"] as const;

export function useGcpContext(slug: string, enabled = true) {
  return useQuery({
    queryKey: key(slug),
    queryFn: () => api.get<GcpContext>(`/projects/${slug}/gcp/context`),
    enabled: enabled && !!slug,
    staleTime: 30_000,
  });
}

export function useSaveGcpContext(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { gcpProjectId?: string; region?: string }) => {
      const res = await api.patch<{ ok: boolean; code?: string }>(`/projects/${slug}/gcp/context`, body);
      if (!res.ok) throw new Error(res.code ?? "Could not save GCP context.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key(slug) });
      qc.invalidateQueries({ queryKey: ["p", slug, "providers"] });
    },
  });
}
