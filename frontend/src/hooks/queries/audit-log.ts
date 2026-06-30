"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

export type AuditLogRow = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  ipAddress: string | null;
  metadata: unknown;
  createdAt: string;
};

/** Project-scoped audit trail. Latest 200 entries by default. */
export function useProjectAuditLog(slug: string, opts?: { action?: string; limit?: number }) {
  return useQuery({
    queryKey: ["p", slug, "audit-log", opts?.action ?? "all", opts?.limit ?? 200],
    queryFn: () =>
      api.get<AuditLogRow[]>(`/projects/${slug}/audit-log`, {
        ...(opts?.action ? { action: opts.action } : {}),
        ...(opts?.limit ? { limit: opts.limit } : {}),
      }),
    staleTime: 30_000,
  });
}
