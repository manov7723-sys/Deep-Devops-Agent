"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiErrorMessage } from "@/lib/api/client";

// ── Terraform pipeline ────────────────────────────────────────────────
// Client mirror of the server engine's run shape (src/lib/devops/terraform-run.ts).
// Defined here (not imported) so node-only modules don't leak into the bundle.
export type TfStageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type TfRunStatus = "queued" | "running" | "succeeded" | "failed";
export type TfStage = {
  name: string;
  status: TfStageStatus;
  logs: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
};
export type TfRun = {
  id: string;
  envKey: string;
  name: string;
  action: "plan" | "apply";
  status: TfRunStatus;
  stages: TfStage[];
  createdAt: string;
  finishedAt?: string;
  error?: string;
};

// ── AWS account onboarding (cross-account STS AssumeRole) ──────────────
export type AwsExternalIdResponse = {
  ok: boolean;
  externalId: string;
  accountId: string;
  accountConfigured: boolean;
  trustPolicy: unknown;
};

/**
 * The caller's app-dictated ExternalId + ready-to-paste IAM trust policy.
 * The ExternalId is generated/owned by the platform and DISPLAYED to the user
 * (never typed in) — it's the same one across every AWS account they connect.
 */
export function useAwsExternalId(enabled = true) {
  return useQuery({
    queryKey: ["onboard", "aws", "external-id"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => api.get<AwsExternalIdResponse>("/onboard/aws/external-id"),
  });
}

export type ConnectAwsInput = {
  roleArn: string;
  region: string;
  accountRef?: string;
  projectSlug?: string;
};
export type ConnectAwsResult = {
  ok: boolean;
  provider?: { id: string };
  verified?: boolean;
  verifyCode?: string;
  verifyMessage?: string;
  code?: string;
  message?: string;
  stderr?: string;
};

/** Connect a customer AWS account: server assumes the role with our ExternalId. */
export function useConnectAwsAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConnectAwsInput) => {
      const res = await api.post<ConnectAwsResult>("/onboard/aws/connect", input);
      if (!res.ok || !res.provider)
        throw new Error(res.message ?? "Could not connect AWS account.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cloud-providers"] }),
  });
}

// ── Kubernetes manifest builder ───────────────────────────────────────
import type { ApiResource } from "@/lib/devops/manifest-templates";

export type ApiVersionsResponse = {
  ok: boolean;
  source: "cluster" | "builtin";
  apiVersions: string[];
  note?: string;
};
export type ApiResourcesResponse = {
  ok: boolean;
  source: "cluster" | "builtin";
  resources: ApiResource[];
  note?: string;
};

/** Live apiVersions from the env's cluster (falls back to a built-in list). */
export function useClusterApiVersions(slug: string, envKey: string, enabled = true) {
  return useQuery({
    queryKey: ["k8s", "api-versions", slug, envKey],
    enabled: enabled && !!slug && !!envKey,
    staleTime: 5 * 60_000,
    queryFn: async () =>
      api.get<ApiVersionsResponse>(`/projects/${slug}/envs/${envKey}/kubernetes/api-versions`),
  });
}

/** Live resource kinds from the env's cluster (falls back to a built-in list). */
export function useClusterApiResources(slug: string, envKey: string, enabled = true) {
  return useQuery({
    queryKey: ["k8s", "api-resources", slug, envKey],
    enabled: enabled && !!slug && !!envKey,
    staleTime: 5 * 60_000,
    queryFn: async () =>
      api.get<ApiResourcesResponse>(`/projects/${slug}/envs/${envKey}/kubernetes/api-resources`),
  });
}

export type PushInfraInput = {
  repoFullName: string;
  basePath: string;
  files: Record<string, string>;
  branch: string;
  message: string;
  pullRequestBody?: string;
};
export type PushInfraResult = {
  ok: boolean;
  repoFullName?: string;
  branch?: string;
  basePath?: string;
  committed?: string[];
  pullRequest?: { number: number; url: string };
};

/** Commit a set of generated infra files to a repo (custom base path) + open a PR. */
export function usePushInfraFiles(slug: string) {
  return useMutation({
    mutationFn: async (input: PushInfraInput) => {
      try {
        const res = await api.post<PushInfraResult>(`/projects/${slug}/infra/push`, input);
        if (!res.ok) throw new Error("Push failed.");
        return res;
      } catch (e) {
        throw new Error(apiErrorMessage(e, "Could not push to GitHub."));
      }
    },
  });
}

// ── Helm chart deploy (static builder "Deploy" button) ────────────────
export type HelmDeployInput = {
  envKey: string;
  repoFullName: string;
  chartPath: string;
  releaseName: string;
  imageRepository?: string;
  imageTag?: string;
  ref?: string;
};
export type HelmDeployResult = {
  ok: boolean;
  result?: {
    envKey: string;
    releaseName: string;
    namespace: string;
    chartPath: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  };
};

/** Deploy a Helm chart (already in a repo) to an env's cluster via helm upgrade. */
export function useDeployHelmChart(slug: string) {
  return useMutation({
    mutationFn: async ({ envKey, ...body }: HelmDeployInput) => {
      try {
        const res = await api.post<HelmDeployResult>(
          `/projects/${slug}/envs/${envKey}/helm/deploy`,
          body,
        );
        if (!res.ok) throw new Error("Deploy failed.");
        return res;
      } catch (e) {
        throw new Error(apiErrorMessage(e, "Could not deploy the Helm chart."));
      }
    },
  });
}

export type CommitManifestInput = {
  repoFullName: string;
  path: string;
  content: string;
  branch: string;
  message: string;
  pullRequestBody?: string;
};
export type CommitManifestResult = {
  ok: boolean;
  fullName?: string;
  path?: string;
  branch?: string;
  commitSha?: string;
  pullRequest?: { number: number; url: string };
};

/** Commit a generated manifest to a repo and open a PR. */
export function useCommitManifest(slug: string) {
  return useMutation({
    mutationFn: async (input: CommitManifestInput) => {
      try {
        const res = await api.post<CommitManifestResult>(
          `/projects/${slug}/manifests/commit`,
          input,
        );
        if (!res.ok) throw new Error("Commit failed.");
        return res;
      } catch (e) {
        throw new Error(apiErrorMessage(e, "Could not commit the manifest."));
      }
    },
  });
}

/** List recent Terraform runs for an env. Polls while any run is active. */
export function useTerraformRuns(slug: string, envKey: string, enabled = true) {
  return useQuery({
    queryKey: ["terraform", "runs", slug, envKey],
    enabled: enabled && !!slug && !!envKey,
    queryFn: async () =>
      api.get<{ ok: boolean; runs: TfRun[] }>(`/projects/${slug}/envs/${envKey}/terraform`),
    refetchInterval: (q) => {
      const runs = q.state.data?.runs ?? [];
      const active = runs.some((r) => r.status === "queued" || r.status === "running");
      return active ? 2_000 : false;
    },
  });
}

/** Poll a single Terraform run; stops polling once it finishes. */
export function useTerraformRun(slug: string, envKey: string, runId: string | null) {
  return useQuery({
    queryKey: ["terraform", "run", slug, envKey, runId],
    enabled: !!slug && !!envKey && !!runId,
    queryFn: async () =>
      api.get<{ ok: boolean; run: TfRun }>(`/projects/${slug}/envs/${envKey}/terraform/${runId}`),
    refetchInterval: (q) => {
      const s = q.state.data?.run?.status;
      return s === "queued" || s === "running" ? 1_500 : false;
    },
  });
}

export type StartTfRunInput = {
  action: "plan" | "apply";
  name: string;
  files: Record<string, string>;
  /** Stable logical stack id so state is keyed consistently (not by run name). */
  stack?: string;
};

// ── Cluster connection (EKS / AKS / GKE) ──────────────────────────────
export type ClusterNode = { name: string; status: string; version: string };
export type ConnectClusterInput = {
  cloud: "aws" | "azure" | "gcp";
  clusterName: string;
  region?: string;
  resourceGroup?: string;
  project?: string;
};
export type ConnectClusterResult = {
  ok: boolean;
  code?: string;
  message?: string;
  cloud?: string;
  cluster?: string;
  stored?: boolean;
  verified?: boolean;
  nodes?: ClusterNode[];
  stderr?: string;
  verifyError?: string;
};

export type ClusterStatusResult = {
  ok: boolean;
  connected: boolean;
  verified?: boolean;
  cluster?: string;
  nodes?: ClusterNode[];
  verifyError?: string;
};

/** Live status of an env's connected cluster (lists nodes from the stored kubeconfig). */
export function useClusterStatus(slug: string, envKey: string, enabled = true) {
  return useQuery({
    queryKey: ["p", slug, "cluster-status", envKey],
    enabled: enabled && !!slug && !!envKey,
    staleTime: 30_000,
    queryFn: async () =>
      api.get<ClusterStatusResult>(`/projects/${slug}/envs/${envKey}/cluster-status`),
  });
}

/** Connect a running cluster (runs the cloud CLI, stores kubeconfig on the env). */
export function useConnectCluster(slug: string, envKey: string) {
  return useMutation({
    mutationFn: async (input: ConnectClusterInput) =>
      api.post<ConnectClusterResult>(`/projects/${slug}/envs/${envKey}/connect-cluster`, input),
  });
}

/** Start a Terraform run (init → plan → optional apply) for an env. */
export function useStartTerraformRun(slug: string, envKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: StartTfRunInput) =>
      api.post<{ ok: boolean; run?: TfRun; code?: string; message?: string }>(
        `/projects/${slug}/envs/${envKey}/terraform`,
        input,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["terraform", "runs", slug, envKey] }),
  });
}

export type RerunTfRunInput = {
  runId: string;
  /** Override the source run's action ("plan" → "apply" upgrades a preview). Default: reuse. */
  action?: "plan" | "apply";
};

export type DeleteGkeClusterInput = {
  project: string;
  location: string;
  name: string;
};

export type ProvisionAzureTfstateInput = {
  resourceGroup: string;
  storageAccount: string;
  container: string;
  location?: string;
};

export type ProvisionAzureTfstateResult = {
  ok: boolean;
  steps?: string[];
  backend?: {
    resourceGroup: string;
    storageAccount: string;
    container: string;
    location: string;
  };
  code?: string;
  message?: string;
};

/**
 * Provision the resource group + storage account + blob container that
 * Terraform's azurerm backend needs — via Azure REST using the env's stored
 * creds, no CLI. Server also persists the three names onto the env row on
 * success, so the tfstate form doesn't need a separate Save click after.
 */
export function useProvisionAzureTfstate(slug: string, envKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProvisionAzureTfstateInput) =>
      api.post<ProvisionAzureTfstateResult>(
        `/projects/${slug}/envs/${envKey}/azure-tfstate-provision`,
        input,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["p", slug, "tf-backend", envKey] });
    },
  });
}

/**
 * Delete an orphaned GKE cluster via the env's stored GCP creds — used by
 * the "Delete existing cluster" button on failed apply runs when Terraform
 * hit 409 alreadyExists (typically after an earlier apply timed out mid-create
 * and lost state). Server fires DELETE + polls the operation until DONE.
 */
export function useDeleteGkeCluster(slug: string, envKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeleteGkeClusterInput) =>
      api.post<{
        ok: boolean;
        deleted?: boolean;
        alreadyGone?: boolean;
        code?: string;
        message?: string;
      }>(`/projects/${slug}/envs/${envKey}/gke-cluster-delete`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["terraform", "runs", slug, envKey] }),
  });
}

/**
 * Rerun a prior Terraform run by id — replays the same files/stack/backend
 * held in the server's in-memory ring. Server returns 410 gone if the run's
 * source spec has been evicted (older than the last 100 runs); the mutation
 * surfaces that as an error the UI can render inline.
 */
export function useRerunTerraformRun(slug: string, envKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RerunTfRunInput) =>
      api.post<{ ok: boolean; run?: TfRun; code?: string; message?: string }>(
        `/projects/${slug}/envs/${envKey}/terraform/${input.runId}/rerun`,
        input.action ? { action: input.action } : {},
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["terraform", "runs", slug, envKey] }),
  });
}

/**
 * Delete a single Terraform run from the pipeline list. Removes ONLY the
 * run record (DB + in-memory) — never touches the underlying cloud infra or
 * remote state, so it's safe to spam. Rejected by the server (409) while the
 * run is still queued/running; UI should disable the button in that case.
 */
export function useDeleteTerraformRun(slug: string, envKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { runId: string }) => {
      try {
        return await api.del<{ ok: boolean }>(
          `/projects/${slug}/envs/${envKey}/terraform/${input.runId}`,
        );
      } catch (e) {
        throw new Error(apiErrorMessage(e, "Could not delete the run."));
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["terraform", "runs", slug, envKey] }),
  });
}
