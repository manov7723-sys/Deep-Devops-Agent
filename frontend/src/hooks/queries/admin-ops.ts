"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  SeedAdminAddonPurchase,
  SeedAdminInvoice,
  SeedAgent,
  SeedAdminModel,
  SeedMcpConnector,
  SeedPlatformSettings,
  BillingStats,
} from "@/lib/legacy-types";

const AGENT_KEY = ["admin", "agents"] as const;
const MODEL_KEY = ["admin", "models"] as const;
const MCP_KEY = ["admin", "mcp"] as const;

export function useAdminAddons() {
  return useQuery({
    queryKey: ["admin", "addons"],
    queryFn: () => api.get<SeedAdminAddonPurchase[]>("/admin/addons"),
    staleTime: 60_000,
  });
}

export function useAdminInvoices() {
  return useQuery({
    queryKey: ["admin", "billing", "invoices"],
    queryFn: () => api.get<SeedAdminInvoice[]>("/admin/billing"),
    staleTime: 60_000,
  });
}

export function useAdminBillingStats() {
  return useQuery({
    queryKey: ["admin", "billing", "stats"],
    queryFn: () => api.get<BillingStats>("/admin/billing/stats"),
    staleTime: 60_000,
  });
}

export function useAdminMcpList() {
  return useQuery({
    queryKey: MCP_KEY,
    queryFn: () => api.get<SeedMcpConnector[]>("/admin/mcp"),
    staleTime: 30_000,
  });
}

export function useAdminMcpAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; action: "reconnect" | "configure" | "logs" }) => {
      const res = await api.post<{ ok: boolean; connector: SeedMcpConnector }>(
        `/admin/mcp/${input.id}`,
        { action: input.action },
      );
      if (!res.ok) throw new Error("Could not run action.");
      return res.connector;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: MCP_KEY }),
  });
}

export function useAdminAgents() {
  return useQuery({
    queryKey: AGENT_KEY,
    queryFn: () => api.get<SeedAgent[]>("/admin/agents"),
    staleTime: 60_000,
  });
}

export type CreateAgentInput = {
  name: string;
  skill: string;
  triggerDescription: string;
  approvalPolicy: string;
  modelId?: string;
  systemPrompt: string;
  enabled?: boolean;
};

export function useAdminAgentCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAgentInput) => {
      const res = await api.post<{
        ok: boolean;
        agent?: SeedAgent;
        message?: string;
        code?: string;
      }>("/admin/agents", input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not create agent.");
      return res.agent!;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENT_KEY }),
  });
}

export function useAdminAgentPatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: Partial<Pick<SeedAgent, "on" | "prompt">> }) => {
      // Same enabled ↔ on translation as useAdminModelPatch.
      const body: Record<string, unknown> = {};
      if (input.patch.on !== undefined) body.enabled = input.patch.on;
      if (input.patch.prompt !== undefined) body.prompt = input.patch.prompt;
      const res = await api.patch<{ ok: boolean; agent: SeedAgent }>(
        `/admin/agents/${input.id}`,
        body,
      );
      if (!res.ok) throw new Error("Could not update agent.");
      return res.agent;
    },
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: AGENT_KEY });
      const prev = qc.getQueryData<SeedAgent[]>(AGENT_KEY);
      if (prev) {
        qc.setQueryData<SeedAgent[]>(
          AGENT_KEY,
          prev.map((a) => (a.id === input.id ? { ...a, ...input.patch } : a)),
        );
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(AGENT_KEY, ctx.prev);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENT_KEY }),
  });
}

export function useAdminModels() {
  return useQuery({
    queryKey: MODEL_KEY,
    queryFn: () => api.get<SeedAdminModel[]>("/admin/models"),
    staleTime: 60_000,
  });
}

export type CreateModelInput = {
  name: string;
  provider: "Anthropic" | "OpenAI" | "Groq" | "SelfHosted" | "Google";
  enabled?: boolean;
  isDefault?: boolean;
  ctxTokens?: number;
  costNote?: string;
};

export function useAdminModelCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateModelInput) => {
      const res = await api.post<{
        ok: boolean;
        model?: SeedAdminModel;
        message?: string;
        code?: string;
      }>("/admin/models", input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not create model.");
      return res.model!;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: MODEL_KEY }),
  });
}

export function useAdminModelPatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      patch: Partial<Pick<SeedAdminModel, "on" | "isDefault">>;
    }) => {
      // The list endpoint renames `enabled` → `on` for the UI; the PATCH
      // route expects the schema-side name `enabled` again. Translate here
      // so callers can keep using the legacy field name.
      const body: Record<string, unknown> = {};
      if (input.patch.on !== undefined) body.enabled = input.patch.on;
      if (input.patch.isDefault !== undefined) body.isDefault = input.patch.isDefault;
      const res = await api.patch<{ ok: boolean; model: SeedAdminModel }>(
        `/admin/models/${input.id}`,
        body,
      );
      if (!res.ok) throw new Error("Could not update model.");
      return res.model;
    },
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: MODEL_KEY });
      const prev = qc.getQueryData<SeedAdminModel[]>(MODEL_KEY);
      if (!prev) return { prev };
      qc.setQueryData<SeedAdminModel[]>(
        MODEL_KEY,
        prev.map((m) => {
          if (input.patch.isDefault === true) {
            return { ...m, isDefault: m.id === input.id };
          }
          return m.id === input.id ? { ...m, ...input.patch } : m;
        }),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(MODEL_KEY, ctx.prev);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: MODEL_KEY }),
  });
}

export function usePlatformSettings() {
  return useQuery({
    queryKey: ["admin", "settings"],
    queryFn: () => api.get<SeedPlatformSettings>("/admin/settings"),
    staleTime: 60_000,
  });
}

export function usePlatformSettingsPatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      patch: Partial<{
        siteTitle: string;
        metaDescription: string;
        smtpHost: string;
        smtpPort: string;
        fromAddress: string;
      }>,
    ) => {
      const res = await api.patch<{ ok: boolean; settings: SeedPlatformSettings }>(
        "/admin/settings",
        patch,
      );
      if (!res.ok) throw new Error("Could not save settings.");
      return { settings: res.settings, patch };
    },
    // Phase 10 — merge server response into cache rather than replacing it.
    // Phase 11 Prisma returns slim DTOs (just the changed scalar fields);
    // cached envVars / assets / systemStatus would otherwise be wiped.
    onSuccess: ({ settings, patch }) => {
      qc.setQueryData<SeedPlatformSettings>(["admin", "settings"], (prev) => {
        const base = prev ?? settings;
        return {
          ...base,
          branding: {
            ...base.branding,
            siteTitle: patch.siteTitle ?? settings.branding?.siteTitle ?? base.branding.siteTitle,
            metaDescription:
              patch.metaDescription ??
              settings.branding?.metaDescription ??
              base.branding.metaDescription,
          },
          email: {
            ...base.email,
            smtpHost: patch.smtpHost ?? settings.email?.smtpHost ?? base.email.smtpHost,
            smtpPort: patch.smtpPort ?? settings.email?.smtpPort ?? base.email.smtpPort,
            fromAddress: patch.fromAddress ?? settings.email?.fromAddress ?? base.email.fromAddress,
          },
        };
      });
    },
  });
}

/* ─────────────── OAuth provider configs ─────────────── */

export type OAuthConfigRow = {
  provider: "github" | "google";
  clientId: string;
  hasSecret: boolean;
  secretMask: string;
  enabled: boolean;
  updatedAt: string;
};

const OAUTH_KEY = ["admin", "oauth"] as const;

export function useAdminOAuthConfigs() {
  return useQuery({
    queryKey: OAUTH_KEY,
    queryFn: () => api.get<OAuthConfigRow[]>("/admin/oauth"),
    staleTime: 60_000,
  });
}

export function useUpsertAdminOAuthConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      provider: "github" | "google";
      clientId: string;
      clientSecret?: string;
      enabled?: boolean;
    }) => {
      const res = await api.post<{
        ok: boolean;
        config?: OAuthConfigRow;
        message?: string;
        code?: string;
      }>("/admin/oauth", input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not save provider config.");
      return res.config!;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: OAUTH_KEY }),
  });
}

export function useToggleAdminOAuthConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { provider: "github" | "google"; enabled: boolean }) => {
      const res = await api.patch<{ ok: boolean; message?: string; code?: string }>(
        `/admin/oauth/${input.provider}`,
        { enabled: input.enabled },
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not toggle provider.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: OAUTH_KEY }),
  });
}

export function useClearAdminOAuthConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (provider: "github" | "google") => {
      const res = await api.del<{ ok: boolean; message?: string; code?: string }>(
        `/admin/oauth/${provider}`,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not clear provider.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: OAUTH_KEY }),
  });
}
