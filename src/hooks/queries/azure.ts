import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

export type AzureContext = {
  ok: boolean;
  connected: boolean;
  subscriptionId?: string;
  resourceGroup?: string | null;
  region?: string;
  cloudEnvironment?: string;
  subscriptions?: Array<{ subscriptionId: string; displayName: string; state: string }>;
  resourceGroups?: Array<{ name: string; location: string }>;
  authError?: string | null;
};

export type SaveAzureContext = {
  subscriptionId?: string;
  resourceGroup?: string;
  region?: string;
  cloudEnvironment?: "AzurePublic" | "AzureUSGovernment" | "AzureChina";
};

const key = (slug: string) => ["p", slug, "azure-context"] as const;

export function useAzureContext(slug: string, enabled = true) {
  return useQuery({
    queryKey: key(slug),
    queryFn: () => api.get<AzureContext>(`/projects/${slug}/azure/context`),
    enabled: enabled && !!slug,
    staleTime: 30_000,
  });
}

export function useSaveAzureContext(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: SaveAzureContext) => {
      const res = await api.patch<{ ok: boolean; code?: string }>(`/projects/${slug}/azure/context`, body);
      if (!res.ok) throw new Error(res.code ?? "Could not save Azure context.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key(slug) });
      qc.invalidateQueries({ queryKey: ["p", slug, "providers"] });
    },
  });
}
