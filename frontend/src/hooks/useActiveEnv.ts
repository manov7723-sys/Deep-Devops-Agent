"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

/**
 * The project's ACTIVE environment key (set on the Environments page). Env-scoped
 * pages use it as the default selection; returns null until loaded / if unset.
 */
export function useActiveEnv(slug: string): string | null {
  const { data } = useQuery<{ ok: boolean; activeEnvKey: string | null }>({
    queryKey: ["p", slug, "active-env"],
    queryFn: () => api.get<{ ok: boolean; activeEnvKey: string | null }>(`/projects/${slug}/active-env`),
    staleTime: 30_000,
  });
  return data?.activeEnvKey ?? null;
}
