"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type { ProjectSummary } from "@/lib/api/schemas/projects-api";

export type Project = ProjectSummary;

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      const res = await api.get<{ projects: Project[] }>("/projects");
      return res.projects;
    },
    staleTime: 5 * 60_000,
  });
}

/** Bare project creation — name + description + colorHue only. */
export type CreateProjectInput = {
  name: string;
  description?: string;
  colorHue?: number;
};

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProjectInput) => {
      const res = await api.post<{
        ok: boolean;
        project?: { id: string; slug: string };
        message?: string;
      }>("/projects", input);
      if (!res.ok || !res.project) {
        throw new Error(res.message ?? "Could not create project.");
      }
      return res.project;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

/**
 * Bundled wizard creation — creates the Project AND dispatches repo attaches,
 * env creates, and cloud-provider create + linking in a single round-trip.
 * Sub-steps that fail are reported back per-item; the project itself is still
 * created so the user can retry individual pieces.
 */
export type RepoChoiceInput = {
  githubId: string;
  name: string;
  fullName: string;
  defaultBranch?: string;
  visibility?: "private" | "public";
  lang?: string;
  description?: string;
  kind?: "Service" | "Frontend" | "Terraform" | "Kubernetes" | "Library" | "Worker";
  /** OAuthAccount.id whose token grants access to this repo. */
  oauthAccountId?: string;
};

export type EnvChoiceInput = {
  key: string;
  name: string;
  isProduction?: boolean;
  autoDeploy?: boolean;
  promotionRank?: number;
  region?: string;
};

export type CloudChoiceInput = {
  kind: "aws" | "gcp" | "azure";
  name: string;
  accountRef: string;
  accountId?: string;
  region: string;
  roleArn?: string;
  externalId?: string;
  /** AWS long-lived keys — stored in Vault server-side, never echoed back. */
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  /** Terraform remote-state backend applied to every env created here. */
  tfBackend?: { bucket: string; region: string; table?: string };
};

export type CreateProjectWithSetupInput = {
  name: string;
  description?: string;
  colorHue?: number;
  repos?: RepoChoiceInput[];
  envs?: EnvChoiceInput[];
  cloud?: CloudChoiceInput | null;
  /** Which cloud the project targets ("aws"|"gcp"|"azure"|"proxmox"); locks the Connect-provider UI. */
  cloudKind?: "aws" | "gcp" | "azure" | "proxmox" | null;
};

export type CreateProjectWithSetupStep = {
  step: "repo" | "env" | "cloud" | "vault" | "tfstate";
  ok: boolean;
  label: string;
  code?: string;
  message?: string;
};

export type CreateProjectWithSetupResult = {
  project: { id: string; slug: string };
  steps: CreateProjectWithSetupStep[];
  summary: { totalSteps: number; okSteps: number; failedSteps: number };
};

export function useCreateProjectWithSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: CreateProjectWithSetupInput,
    ): Promise<CreateProjectWithSetupResult> => {
      const res = await api.post<{
        ok: boolean;
        project?: { id: string; slug: string };
        steps?: CreateProjectWithSetupStep[];
        summary?: { totalSteps: number; okSteps: number; failedSteps: number };
        message?: string;
      }>("/projects/with-setup", input);
      if (!res.ok || !res.project) {
        throw new Error(res.message ?? "Could not create project.");
      }
      return {
        project: res.project,
        steps: res.steps ?? [],
        summary: res.summary ?? { totalSteps: 0, okSteps: 0, failedSteps: 0 },
      };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}
