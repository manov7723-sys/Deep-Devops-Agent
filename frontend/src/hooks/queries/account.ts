"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

export type Profile = {
  firstName: string;
  lastName: string;
  email: string;
  jobTitle: string;
  timezone: string;
};

const PROFILE_KEY = ["account", "profile"];
const TWOFA_KEY = ["account", "2fa"];
const CODES_KEY = ["account", "backup-codes"];

export function useProfile() {
  return useQuery({
    queryKey: PROFILE_KEY,
    queryFn: () => api.get<Profile>("/account/profile"),
    staleTime: 30_000,
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<Profile>) => {
      const res = await api.patch<{ ok: boolean; profile: Profile; message?: string }>(
        "/account/profile",
        input,
      );
      if (!res.ok) throw new Error(res.message ?? "Could not update profile.");
      return res.profile;
    },
    onSuccess: (profile) => {
      qc.setQueryData(PROFILE_KEY, profile);
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: async (input: { current: string; password: string; confirmPassword: string }) => {
      const res = await api.post<{ ok: boolean; message?: string }>(
        "/account/password",
        input,
      );
      if (!res.ok) throw new Error(res.message ?? "Could not change password.");
      return true;
    },
  });
}

export function use2FA() {
  return useQuery({
    queryKey: TWOFA_KEY,
    queryFn: () => api.get<{ enabled: boolean; codes: string[] }>("/account/2fa"),
    staleTime: 30_000,
  });
}

export function useToggle2FA() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await api.post<{ ok: boolean; enabled: boolean }>("/account/2fa", { enabled });
      if (!res.ok) throw new Error("Could not update 2FA.");
      return res.enabled;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: TWOFA_KEY }),
  });
}

/**
 * Backup-code STATUS — never the plaintext codes. The plaintext set is
 * returned exactly once by `useRegenerateBackupCodes`; this query just
 * tells the UI how many codes remain so it can show a counter.
 */
export type BackupCodeStatus = { remaining: number; total: number };

export function useBackupCodes() {
  return useQuery({
    queryKey: CODES_KEY,
    queryFn: () => api.get<BackupCodeStatus>("/account/backup-codes"),
    staleTime: 60_000,
  });
}

export function useRegenerateBackupCodes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<{ ok: boolean; codes: string[] }>("/account/backup-codes");
      if (!res.ok) throw new Error("Could not regenerate codes.");
      return res.codes;
    },
    onSuccess: () => {
      // Don't put the plaintext codes into the cached query — that's a
      // status query. The caller renders the returned codes locally for
      // one-shot display.
      qc.invalidateQueries({ queryKey: CODES_KEY });
      qc.invalidateQueries({ queryKey: TWOFA_KEY });
    },
  });
}

/* ─────────────── Connected OAuth accounts ─────────────── */

export type ConnectedOAuthAccount = {
  id: string;
  provider: "github" | "google";
  providerAccountId: string;
  login: string | null;
  avatarUrl: string | null;
  scope: string | null;
  hasToken: boolean;
  tokenExpiresAt: string | null;
  createdAt: string;
};

const OAUTH_ACCOUNTS_KEY = ["account", "oauth-accounts"];

export function useConnectedOAuthAccounts() {
  return useQuery({
    queryKey: OAUTH_ACCOUNTS_KEY,
    queryFn: () => api.get<ConnectedOAuthAccount[]>("/account/oauth-accounts"),
    staleTime: 30_000,
  });
}

export function useDisconnectOAuthAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.del<{ ok: boolean; message?: string; code?: string }>(
        `/account/oauth-accounts/${id}`,
      );
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not disconnect account.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: OAUTH_ACCOUNTS_KEY }),
  });
}
