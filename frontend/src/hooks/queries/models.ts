"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

export type AvailableModelRow = {
  id: string;
  name: string;
  provider: string;
  ctx: string;
  isDefault: boolean;
};

/**
 * Models the current user can pick from — only those an admin has enabled
 * (`Model.enabled = true`) at the platform level. Used by the project
 * Settings "Default model" picker.
 */
export function useAvailableModels() {
  return useQuery({
    queryKey: ["models", "available"],
    queryFn: () => api.get<AvailableModelRow[]>("/models"),
    staleTime: 5 * 60_000,
  });
}
