"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

export type CostSnapshotHistoryRow = {
  id: string;
  periodStart: string;
  totalCents: number;
  forecastCents: number | null;
  budgetCents: number | null;
  savingsCents: number | null;
  untaggedCents: number | null;
  envCount: number;
  serviceCount: number;
};

export function useCostHistory(slug: string) {
  return useQuery({
    queryKey: ["p", slug, "cost", "history"],
    queryFn: () => api.get<CostSnapshotHistoryRow[]>(`/projects/${slug}/cost/history`),
    staleTime: 60_000,
  });
}

export function useSynthesizeCost(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body?: { periodStart?: string; budgetCents?: number }) => {
      const res = await api.post<{
        ok: boolean;
        snapshot?: unknown;
        summary?: {
          resources: number;
          envs: number;
          services: number;
          totalCents: number;
          forecastCents: number;
          budgetCents: number;
        };
        message?: string;
      }>(`/projects/${slug}/cost/synthesize`, body ?? {});
      if (!res.ok) throw new Error(res.message ?? "Could not record snapshot.");
      return res;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["p", slug, "cost"] });
    },
  });
}
