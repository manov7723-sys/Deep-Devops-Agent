"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import {
  Badge,
  Btn,
  Field,
  Icon,
  Input,
  Modal,
  Select,
  Textarea,
  WizardSteps,
} from "@/components/ui";
import { HuePicker } from "@/components/ui/HuePicker";
import { ProjectAvatar } from "@/components/domain/ProjectAvatar";
import { useGitHubMe, useGitHubRepos } from "@/hooks/queries/repos";
import { useConnectedOAuthAccounts } from "@/hooks/queries/account";
import {
  useCreateProjectWithSetup,
  type RepoChoiceInput,
  type EnvChoiceInput,
} from "@/hooks/queries/projects";
import { useConnectAwsAccount } from "@/hooks/queries/connectivity";
import { RepoAnalysisStep, type PlanItems } from "@/components/domain/RepoAnalysisStep";
import type { RepoAnalysisReport } from "@/lib/analysis/repo-analyzer";

// Step order chosen for the create-project wizard (v4), in order:
//   1. Details       — who owns this and what's it called
//   2. Cloud         — pick cloud + region AND connect the account inline
//                      (required-but-skippable — "I'll connect later" escape
//                      hatch, so a failed connect never traps the wizard)
//   3. Repository    — pick the repo the analyzer will read
//   4. Analysis      — verdict + language deep detection + capacity slider
//                      + missing-file scaffolding + README gate
//   5. Environments  — dev / staging / prod toggles + per-env branch dropdown
//                      populated from the repo's actual branches
const STEPS = ["Details", "Cloud", "Repository", "Analysis", "Environments"] as const;
type EnvKey = "dev" | "staging" | "prod";

// Env metadata for the wizard. Suggested branch names are just heuristics —
// the actual dropdown values come from the repo's real branch list. Each
// env's `suggested` matches the common GitOps convention and is auto-picked
// only when a branch with that name exists in the repo.
const ENV_META: Record<
  EnvKey,
  { tone: "info" | "warn" | "ok"; suggested: string[]; label: string; autoDeploy: boolean }
> = {
  dev:     { tone: "info", suggested: ["develop", "dev", "main"],    label: "Dev",     autoDeploy: true  },
  staging: { tone: "warn", suggested: ["staging", "stage", "main"],  label: "Staging", autoDeploy: true  },
  prod:    { tone: "ok",   suggested: ["main", "master", "release"], label: "Prod",    autoDeploy: false },
};

/**
 * Proxmox joins AWS/GCP/Azure as a first-class chip so on-prem doesn't need a
 * separate first-screen fork. The chip flow gates the Continue button and inline
 * connect card the same way it does for the clouds — Proxmox specifically defers
 * connect to the Cloud providers tab after creation (needs projectSlug for the
 * host URL + API token form).
 */
const CLOUDS = ["AWS", "GCP", "Azure", "Proxmox"] as const;

/**
 * Per-provider strings for the wizard's step 4. The wizard only PICKS the cloud
 * (and a default region) here — the actual account connection (IAM role + STS
 * ExternalId on AWS, service account on GCP, service principal on Azure) is done
 * afterward on the project's "Cloud providers" tab (ConnectCloudModal), or from
 * chat via the ```cloud-connect``` fence (CloudConnectBox).
 */
/**
 * Region catalog per cloud. The wizard offers only the regions the app has
 * proven creation flows for (EKS/RDS on AWS, GKE on GCP, AKS on Azure). Add a
 * region here once the cluster + DB creation flows have been verified against
 * it — anything unlisted is either unsupported or unused in the wild.
 * For Proxmox the "region" is really a node name; free-text is more useful
 * than a fixed list, so the Select falls back to Input when cloud === Proxmox.
 */
const CLOUD_FIELD_META: Record<
  string,
  { regionPlaceholder: string; note: string; regions: { value: string; label: string }[] }
> = {
  AWS: {
    regionPlaceholder: "us-east-1",
    note: "Deep Agent will assume a scoped AWS IAM role via STS (no long-lived keys).",
    regions: [
      { value: "us-east-1", label: "us-east-1 · N. Virginia" },
      { value: "us-east-2", label: "us-east-2 · Ohio" },
      { value: "us-west-1", label: "us-west-1 · N. California" },
      { value: "us-west-2", label: "us-west-2 · Oregon" },
      { value: "eu-west-1", label: "eu-west-1 · Ireland" },
      { value: "eu-west-2", label: "eu-west-2 · London" },
      { value: "eu-central-1", label: "eu-central-1 · Frankfurt" },
      { value: "ap-south-1", label: "ap-south-1 · Mumbai" },
      { value: "ap-southeast-1", label: "ap-southeast-1 · Singapore" },
      { value: "ap-southeast-2", label: "ap-southeast-2 · Sydney" },
      { value: "ap-northeast-1", label: "ap-northeast-1 · Tokyo" },
    ],
  },
  GCP: {
    regionPlaceholder: "us-central1",
    note: "Deep Agent will impersonate a GCP service account (workload-identity supported).",
    regions: [
      { value: "us-central1", label: "us-central1 · Iowa" },
      { value: "us-east1", label: "us-east1 · S. Carolina" },
      { value: "us-west1", label: "us-west1 · Oregon" },
      { value: "europe-west1", label: "europe-west1 · Belgium" },
      { value: "europe-west2", label: "europe-west2 · London" },
      { value: "asia-south1", label: "asia-south1 · Mumbai" },
      { value: "asia-southeast1", label: "asia-southeast1 · Singapore" },
      { value: "asia-northeast1", label: "asia-northeast1 · Tokyo" },
    ],
  },
  Azure: {
    regionPlaceholder: "eastus",
    note: "Deep Agent will sign in as an Azure service principal.",
    regions: [
      { value: "eastus", label: "eastus · Virginia" },
      { value: "eastus2", label: "eastus2 · Virginia" },
      { value: "westus", label: "westus · California" },
      { value: "westus2", label: "westus2 · Washington" },
      { value: "westeurope", label: "westeurope · Netherlands" },
      { value: "northeurope", label: "northeurope · Ireland" },
      { value: "uksouth", label: "uksouth · London" },
      { value: "southindia", label: "southindia · Chennai" },
      { value: "southeastasia", label: "southeastasia · Singapore" },
      { value: "japaneast", label: "japaneast · Tokyo" },
    ],
  },
  Proxmox: {
    regionPlaceholder: "pve",
    note: "On-prem: after creating the project, connect your Proxmox server (host URL + API token) on the Cloud providers tab, then create VMs with Terraform.",
    regions: [], // node names are user-defined; keep the free-text Input for Proxmox
  },
};

type Draft = {
  name: string;
  description: string;
  hue: number;
  /** Which team OWNS this project. Only teams the current user LEADS are
   *  offered — that's what makes the server-side gate a formality here. */
  teamSlug: string;
  ghConnected: boolean;
  /** Which connected GitHub identity (OAuthAccount.id) this project pulls repos from. */
  ghAccountId: string | null;
  repoIds: Record<string, boolean>;
  envs: Record<EnvKey, boolean>;
  /**
   * Branch each env deploys from. Empty string = "use repo default"; the
   * server persists that as `deployBranch: null` (backward-compatible with
   * the pre-v4 branchless flow).
   */
  envBranches: Record<EnvKey, string>;
  // Step 2: cloud pick + inline connect.
  cloud: string;
  region: string;
  /**
   * Inline-connect state on the Cloud step. `cloudConnected` flips true once
   * the connect API returned ok. `cloudSkipped` flips true when the user
   * clicked "I'll connect later" — either one unlocks Continue. Kept on the
   * draft so localStorage-resume preserves the connected state (the actual
   * CloudProvider row is created out-of-band by the connect API itself).
   */
  cloudConnected: boolean;
  cloudSkipped: boolean;
  /**
   * Infra-repo pick from Step 4 (Analysis). Empty string = same as app repo
   * (Terraform lives in ./infra/). Any other value is the GitHub fullName of
   * a separate repo the user picked to receive generated Terraform + manifests.
   * Persisted into the DeploymentPlan under items.__infraRepo so the
   * in-project RecommendedSetupPanel shows the correct target in its banner.
   */
  infraRepo: string;
};

const DEFAULT_DRAFT: Draft = {
  name: "",
  description: "",
  hue: 285,
  teamSlug: "",
  ghConnected: false,
  ghAccountId: null,
  repoIds: {},
  // Only Prod is on by default — matches the common "one repo, one branch
  // (main)" reality of a fresh project. Users opt-in to Dev/Staging only when
  // they need pre-production environments.
  envs: { dev: false, staging: false, prod: true },
  envBranches: { dev: "", staging: "", prod: "" },
  cloud: "AWS",
  region: "us-east-1",
  cloudConnected: false,
  cloudSkipped: false,
  infraRepo: "",
};

const DRAFT_KEY_PREFIX = "dda-create-project-draft:";

export interface CreateProjectWizardProps {
  open: boolean;
  step: number; // 1-based
  draftId: string;
  onOpenChange: (open: boolean) => void;
  onStepChange: (step: number) => void;
}

/**
 * URL-driven 4-step wizard. State persists to localStorage keyed by draftId
 * so an accidental refresh resumes where the user left off.
 */
export function CreateProjectWizard({
  open,
  step,
  draftId,
  onOpenChange,
  onStepChange,
}: CreateProjectWizardProps) {
  const router = useRouter();
  const qc = useQueryClient();
  const ghAccounts = useConnectedOAuthAccounts();
  const githubAccounts = ghAccounts.data?.filter((a) => a.provider === "github") ?? [];
  const create = useCreateProjectWithSetup();
  const connectAws = useConnectAwsAccount();
  const [serverError, setServerError] = useState<string | null>(null);
  const [ghNote, setGhNote] = useState<string | null>(null);
  const [awsRoleArn, setAwsRoleArn] = useState("");
  const [awsExternalIdOverride, setAwsExternalIdOverride] = useState("");
  const [awsConnectMsg, setAwsConnectMsg] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  // Analysis report + per-recommendation acceptance. Session state only (NOT
  // in the localStorage draft — a report can be hundreds of KB and re-running
  // the analysis on resume is cheap and always fresher).
  const [analysis, setAnalysis] = useState<RepoAnalysisReport | null>(null);
  const [planItems, setPlanItems] = useState<PlanItems>({});

  // Open GitHub OAuth in a POPUP so the wizard never navigates away (no redirect
  // to the home page). The popup hits the start route with `popup=1`; on success
  // the callback closes it and postMessages back here — see the listener below.
  function openGithubPopup() {
    setGhNote(null);
    const w = 640,
      h = 760;
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
    const url = `/api/v1/auth/oauth/github/start?popup=1&next=${encodeURIComponent(
      `/u/projects?new=1&step=2&draft=${draftId}`,
    )}`;
    const popup = window.open(
      url,
      "dda_github_oauth",
      `width=${w},height=${h},left=${left},top=${top}`,
    );
    if (!popup) {
      // Popup blocked — fall back to a full-page redirect to the same flow.
      window.location.href = url.replace("&popup=1", "").replace("?popup=1&", "?");
      return;
    }
    // Safety net: even if the postMessage is blocked (browser COOP), refetch the
    // connected accounts once the popup closes so the connected state appears.
    const timer = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(timer);
        qc.invalidateQueries({ queryKey: ["account", "oauth-accounts"] });
      }
    }, 800);
  }

  // Receive the popup's result and refresh connected GitHub accounts in place.
  // Listen on TWO channels because modern browsers (Chrome COOP) can sever
  // window.opener, silently swallowing postMessage. The callback also writes
  // to localStorage, which fires a 'storage' event in every other same-origin
  // tab — that path survives the COOP break.
  useEffect(() => {
    function handle(
      data: { source?: string; status?: string; code?: string; message?: string } | null,
    ) {
      if (!data || data.source !== "dda-oauth") return;
      if (data.status === "connected") {
        qc.invalidateQueries({ queryKey: ["account", "oauth-accounts"] });
        setDraft((d) => ({ ...d, ghConnected: true }));
        setGhNote(null);
      } else if (data.status === "needs_login") {
        setGhNote("Please sign in to the app first, then connect GitHub.");
      } else if (data.status === "error") {
        // Surface the callback failure inline instead of silently landing the
        // popup on some other page. The wizard stays on step 2 so the user
        // can retry.
        setGhNote(
          data.message
            ? `GitHub sign-in failed: ${data.message}`
            : `GitHub sign-in failed${data.code ? ` (${data.code})` : ""}. Try again.`,
        );
      }
    }
    function onMsg(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      handle(e.data as Parameters<typeof handle>[0]);
    }
    function onStorage(e: StorageEvent) {
      if (e.key !== "dda_github_oauth_result" || !e.newValue) return;
      try {
        handle(JSON.parse(e.newValue));
      } catch {
        /* ignore malformed */
      }
    }
    // On mount, also drain any result the popup wrote just before we mounted
    // (racy case: popup wrote then closed before we subscribed).
    try {
      const pending = localStorage.getItem("dda_github_oauth_result");
      if (pending) {
        localStorage.removeItem("dda_github_oauth_result");
        handle(JSON.parse(pending));
      }
    } catch {
      /* ignore */
    }
    window.addEventListener("message", onMsg);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("message", onMsg);
      window.removeEventListener("storage", onStorage);
    };
  }, [qc]);

  // Active account drives which token the repo-list query uses. Defaults to
  // the draft's chosen one (so it persists across re-opens), then falls back
  // to the first connected GitHub account.
  const effectiveGhAccountId = draft.ghAccountId ?? githubAccounts[0]?.id ?? null;
  const ghQuery = useGitHubRepos(open && !!effectiveGhAccountId, effectiveGhAccountId);
  const ghMe = useGitHubMe(open && !!effectiveGhAccountId, effectiveGhAccountId);
  const repos = ghQuery.data ?? [];
  const repoError = ghQuery.error;

  // First selected repo drives the Analysis + Environments-branches queries.
  const primaryRepoFullName = useMemo(
    () => repos.find((r) => !!draft.repoIds[r.id])?.fullName ?? null,
    [repos, draft.repoIds],
  );
  const primaryRepoDefaultBranch = useMemo(
    () => repos.find((r) => !!draft.repoIds[r.id])?.defaultBranch ?? null,
    [repos, draft.repoIds],
  );
  /** Every repo the user could commit infra to, except the app repo itself. */
  const availableInfraRepos = useMemo(
    () =>
      repos
        .filter((r) => r.fullName !== primaryRepoFullName)
        .map((r) => ({
          value: r.fullName,
          label:
            r.lang && r.lang.trim().length > 0
              ? `${r.fullName} · ${r.lang}${r.kind === "private" ? " · private" : ""}`
              : `${r.fullName}${r.kind === "private" ? " · private" : ""}`,
        })),
    [repos, primaryRepoFullName],
  );

  // Branches list for the Environments step's per-env dropdown. Only enabled
  // when we've actually reached the Env step AND a repo is picked — no point
  // hitting GitHub earlier. Small cache (60 s) so hopping back to step 3 and
  // forward again doesn't re-fetch.
  const branchesQ = useQuery<{ ok: boolean; branches?: Array<{ name: string; protected: boolean }> }>(
    {
      queryKey: ["gh", "branches", primaryRepoFullName, effectiveGhAccountId],
      enabled: open && step === 5 && !!primaryRepoFullName,
      queryFn: () =>
        api.get(
          `/integrations/github/repos/${encodeURIComponent(primaryRepoFullName!)}/branches` +
            (effectiveGhAccountId ? `?accountId=${effectiveGhAccountId}` : ""),
        ),
      staleTime: 60_000,
    },
  );
  const availableBranches = branchesQ.data?.branches ?? [];

  // Auto-pick a sensible default branch per env the first time we see the
  // repo's branch list: pick the first ENV_META.suggested that actually
  // exists, else the repo's default branch. Only fills a slot when the user
  // hasn't already chosen one — never overwrites their pick.
  useEffect(() => {
    if (availableBranches.length === 0) return;
    setDraft((d) => {
      const names = new Set(availableBranches.map((b) => b.name));
      const next: Draft["envBranches"] = { ...d.envBranches };
      let changed = false;
      for (const k of ["dev", "staging", "prod"] as EnvKey[]) {
        if (next[k]) continue; // user already picked
        const suggested = ENV_META[k].suggested.find((s) => names.has(s));
        const picked = suggested ?? primaryRepoDefaultBranch ?? availableBranches[0]!.name;
        if (picked) {
          next[k] = picked;
          changed = true;
        }
      }
      return changed ? { ...d, envBranches: next } : d;
    });
  }, [availableBranches, primaryRepoDefaultBranch]);

  // Reflect the REAL GitHub connection: once a github OAuthAccount exists (after
  // the user returns from the OAuth redirect), mark the step connected so the
  // "Connected as" view + Continue gating work. Without this the connect button
  // only flipped a local flag and never actually authorized GitHub.
  useEffect(() => {
    if (githubAccounts.length > 0 && !draft.ghConnected) {
      setDraft((d) => ({ ...d, ghConnected: true }));
    }
  }, [githubAccounts.length, draft.ghConnected]);
  const repoCode =
    (repoError as { details?: unknown } | null)?.details &&
    typeof (repoError as { details?: unknown }).details === "string"
      ? (() => {
          try {
            const j = JSON.parse((repoError as { details: string }).details);
            return typeof j?.code === "string" ? (j.code as string) : null;
          } catch {
            return null;
          }
        })()
      : null;

  // Restore from localStorage when the wizard opens.
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(DRAFT_KEY_PREFIX + draftId);
      setDraft(raw ? { ...DEFAULT_DRAFT, ...JSON.parse(raw) } : DEFAULT_DRAFT);
    } catch {
      setDraft(DEFAULT_DRAFT);
    }
  }, [open, draftId]);

  // Persist draft to localStorage on every change while open.
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    localStorage.setItem(DRAFT_KEY_PREFIX + draftId, JSON.stringify(draft));
  }, [open, draftId, draft]);

  const stepIdx = Math.max(0, Math.min(STEPS.length - 1, step - 1));
  const initial = useMemo(() => (draft.name.trim()[0] || "N").toUpperCase(), [draft.name]);
  const selectedRepoIds = useMemo(
    () =>
      Object.entries(draft.repoIds)
        .filter(([, on]) => on)
        .map(([id]) => id),
    [draft.repoIds],
  );
  const selectedEnvs = useMemo(
    () => (Object.keys(draft.envs) as EnvKey[]).filter((k) => draft.envs[k]),
    [draft.envs],
  );

  const canNext = (() => {
    switch (stepIdx) {
      case 0: // Details
        // Team is required — the server-side gate would reject an empty
        // teamSlug anyway, so failing fast in the UI is the honest thing.
        return draft.name.trim().length > 0 && draft.teamSlug.trim().length > 0;
      case 1: // Cloud
        // For AWS we ship inline "Connect & verify" (uses the same endpoint
        // the Cloud tab uses). For GCP/Azure/Proxmox the wizard defers to
        // the project's Cloud providers tab — those flows are OAuth-popup /
        // form-heavy and need a projectSlug we don't have yet. Continue is
        // gated ONLY for AWS: connected or explicitly skipped. The wizard
        // NEVER hard-blocks even AWS — "I'll connect later" is always there.
        if (draft.cloud !== "AWS") return true;
        return draft.cloudConnected || draft.cloudSkipped;
      case 2: // Repository
        return draft.ghConnected && selectedRepoIds.length > 0;
      case 3: // Analysis
        // Fail-soft for ERRORS (continue without a report), but two hard
        // gates: missing README (blocking file), or a `not_fit` verdict
        // (no HTTP surface / no worker — not a Kubernetes workload).
        if (analysis?.missingFiles.some((f) => f.blocking)) return false;
        if (analysis?.deployability?.status === "not_fit") return false;
        return true;
      case 4: // Environments — at least one env selected (Prod defaults on)
        return selectedEnvs.length > 0;
      default:
        return false;
    }
  })();

  const last = stepIdx === STEPS.length - 1;

  async function next() {
    if (!canNext) return;
    if (!last) {
      onStepChange(stepIdx + 2);
      return;
    }
    // Submit — bundled create that also attaches the chosen repos, creates
    // the picked envs, and (if filled in) provisions the cloud provider +
    // links it to every env. Per-item failures don't abort: the user gets a
    // per-step result list and the project still gets created.
    setServerError(null);
    try {
      // Translate the wizard draft into the API's input shape.
      const selectedRepos: RepoChoiceInput[] = repos
        .filter((r) => !!draft.repoIds[r.id])
        .map((r) => ({
          githubId: r.id,
          name: r.name,
          fullName: r.fullName,
          defaultBranch: r.defaultBranch,
          visibility: r.kind, // "private" | "public"
          lang: r.lang,
          // Multi-account: tag every selected repo with the connected GitHub
          // identity it was discovered through, so deploy/sync flows later
          // know which token to use.
          oauthAccountId: effectiveGhAccountId ?? undefined,
        }));

      // v4: the Environments step is back. User picked which of dev / staging
      // / prod to create, and (per env) which branch it deploys from. Empty
      // branch → server persists as null (deploy uses repo default — the
      // pre-v4 branchless behaviour, so no regression).
      const envOrder: EnvKey[] = ["dev", "staging", "prod"];
      const selectedEnvsPayload: EnvChoiceInput[] = envOrder
        .filter((k) => draft.envs[k])
        .map((k, i) => ({
          key: k,
          name: ENV_META[k].label,
          isProduction: k === "prod",
          autoDeploy: ENV_META[k].autoDeploy,
          promotionRank: i,
          deployBranch: draft.envBranches[k]?.trim() || undefined,
        }));

      // Step 4 is selection-only — the project records which cloud it targets,
      // but no provider account is created here. The user connects the account
      // afterward on the "Cloud providers" tab (ConnectCloudModal), or from chat
      // via the ```cloud-connect``` fence. So we send no cloud payload;
      // with-setup creates nothing cloud-related.
      const result = await create.mutateAsync({
        name: draft.name.trim(),
        description: draft.description.trim(),
        colorHue: draft.hue,
        // Server rejects with 403 not_team_lead when the caller doesn't lead
        // the chosen team — the picker in the Details step is the only source.
        teamSlug: draft.teamSlug,
        repos: selectedRepos,
        envs: selectedEnvsPayload,
        cloud: null,
        // Record which cloud the project targets so the Connect-provider UI
        // locks to it. Selection-only — no provider is provisioned here.
        cloudKind: draft.cloud.toLowerCase() as "aws" | "gcp" | "azure" | "proxmox",
        // Saved Deployment Plan from the Analysis step — advisory. Absent when
        // the user skipped analysis or it failed (fail-soft by design).
        deploymentPlan: analysis
          ? {
              repoFullName: analysis.repoFullName,
              analyzedAt: analysis.analyzedAt,
              plan: {
                report: analysis,
                // Merge the infra-repo pick into `items` under the reserved
                // sentinel key so RecommendedSetupPanel's banner reads it
                // back without a schema change. Skipped when the user left
                // the default (same-repo).
                // NOTE: __infraRepo is a repo fullName string, not a status,
                // so the merged object escapes PlanItems' status union. Cast
                // to unknown → object; the server accepts `plan` as
                // `z.unknown()` (see /projects/with-setup route), and slice-2's
                // panel reads `items["__infraRepo"]` as a plain string.
                items: (draft.infraRepo && draft.infraRepo !== "__pending__"
                  ? { ...planItems, __infraRepo: draft.infraRepo }
                  : planItems) as unknown as Record<string, string>,
              },
            }
          : null,
      });

      // Surface partial failures so the user isn't blindsided when, say, a
      // repo attach failed but the project still opened.
      if (result.summary.failedSteps > 0) {
        const failed = result.steps
          .filter((s) => !s.ok)
          .map((s) => `${s.step} "${s.label}"`)
          .join(", ");
        setServerError(
          `Project created, but ${result.summary.failedSteps} setup step${result.summary.failedSteps > 1 ? "s" : ""} failed: ${failed}. Retry from the project page.`,
        );
        // Still navigate — the project itself was created.
      }

      localStorage.removeItem(DRAFT_KEY_PREFIX + draftId);
      onOpenChange(false);
      router.push(`/p/${result.project.slug}/dashboard`);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Could not create project.");
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width={620}
      title="Create a project"
      footer={
        <>
          {stepIdx > 0 && (
            <Btn
              variant="ghost"
              icon="chevL"
              style={{ marginRight: "auto" }}
              onClick={() => onStepChange(stepIdx)}
            >
              Back
            </Btn>
          )}
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon={last ? "check" : undefined}
            iconRight={last ? undefined : "chevR"}
            disabled={!canNext}
            loading={create.isPending}
            onClick={next}
          >
            {last ? "Create project" : "Continue"}
          </Btn>
        </>
      }
    >
      <WizardSteps steps={STEPS as unknown as string[]} current={stepIdx} />

      {stepIdx === 0 && (
        <div className="col gap-4">
          <div className="row gap-4" style={{ alignItems: "center" }}>
            <ProjectAvatar name={initial} hue={draft.hue} size={60} radius={15} />
            <div className="col gap-2">
              <span className="field-label" style={{ marginBottom: 0 }}>
                Project icon
              </span>
              <HuePicker value={draft.hue} onChange={(hue) => setDraft((d) => ({ ...d, hue }))} />
            </div>
          </div>
          <Field label="Project name" required>
            <Input
              autoFocus
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="e.g. Northwind Commerce"
            />
          </Field>
          <Field label="Description" hint="Optional — helps agents understand context.">
            <Textarea
              rows={2}
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder="What does this product do?"
            />
          </Field>
          <TeamPicker
            value={draft.teamSlug}
            onChange={(teamSlug) => setDraft((d) => ({ ...d, teamSlug }))}
          />
        </div>
      )}

      {stepIdx === 2 && (
        <div className="col gap-4">
          {!draft.ghConnected ? (
            <div className="col center gap-3 dda-wizard-gh-card">
              <span
                className="row center"
                style={{ width: 48, height: 48, borderRadius: 12, background: "var(--surface-3)" }}
              >
                <Icon name="github" size={24} />
              </span>
              <div className="col gap-1" style={{ textAlign: "center" }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>Connect your code</span>
                <span className="faint" style={{ fontSize: 12.5 }}>
                  Authorize GitHub so Deep Agent can read &amp; open PRs.
                </span>
              </div>
              {/* Real GitHub OAuth in a popup — the wizard stays open and the
                  repo list appears once you authorize. The main window never
                  navigates, so there's no redirect to the home page. */}
              <Btn variant="primary" icon="github" onClick={openGithubPopup}>
                Authorize GitHub
              </Btn>
              {ghNote && (
                <span style={{ fontSize: 12, color: "var(--danger, #e5484d)" }}>{ghNote}</span>
              )}
            </div>
          ) : (
            <>
              <div className="row gap-2 between dda-wizard-gh-connected">
                <span className="row gap-2">
                  <Icon name="check" size={16} /> Connected as{" "}
                  <b>{ghMe.data?.login ?? (ghMe.isLoading ? "…" : "GitHub")}</b>
                </span>
                <span className="row gap-2">
                  {/* Switch / add a different GitHub account: re-runs OAuth in a
                      popup. On GitHub's page use "Not you? Switch account" to pick
                      a different login; the new account appears in the selector
                      below once the popup closes. */}
                  <button type="button" className="btn outline sm" onClick={openGithubPopup}>
                    <Icon name="refresh" size={13} /> Change account
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    style={{ color: "var(--ok)" }}
                    onClick={() => setDraft((d) => ({ ...d, ghConnected: false, repoIds: {} }))}
                  >
                    Disconnect
                  </button>
                </span>
              </div>
              {githubAccounts.length > 1 && (
                <Field
                  label="GitHub account"
                  hint="This project's repos will be pulled from the account you pick here."
                >
                  <Select
                    value={effectiveGhAccountId ?? ""}
                    onValueChange={(v) =>
                      setDraft((d) => ({ ...d, ghAccountId: v || null, repoIds: {} }))
                    }
                    ariaLabel="GitHub account"
                    options={githubAccounts.map((a) => ({
                      value: a.id,
                      label: a.login ? `@${a.login}` : `id:${a.providerAccountId.slice(0, 8)}`,
                    }))}
                  />
                </Field>
              )}
              <Field label="Select repositories" hint={`${selectedRepoIds.length} selected`}>
                {ghQuery.isLoading ? (
                  <span className="muted" style={{ fontSize: 13 }}>
                    Loading your GitHub repositories…
                  </span>
                ) : repoError ? (
                  <div
                    className="col gap-2"
                    style={{
                      border: "1px dashed var(--border)",
                      borderRadius: 8,
                      padding: 12,
                      fontSize: 13,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>
                      {repoCode === "github_not_connected"
                        ? "GitHub isn't connected yet"
                        : repoCode === "github_scope_insufficient"
                          ? "Reconnect GitHub to grant repo access"
                          : "Couldn't load your GitHub repos"}
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {repoCode === "github_not_connected"
                        ? "Sign in with GitHub on the login screen — your repositories will appear here."
                        : repoCode === "github_scope_insufficient"
                          ? "Your existing sign-in doesn't include the `repo` scope. Sign out and back in with GitHub to refresh permissions."
                          : repoError.message}
                    </span>
                    <button
                      type="button"
                      className="btn outline sm"
                      style={{ width: "fit-content" }}
                      onClick={openGithubPopup}
                    >
                      <Icon name="github" size={14} />
                      {repoCode === "github_not_connected" ? "Connect GitHub" : "Reconnect GitHub"}
                    </button>
                  </div>
                ) : repos.length === 0 ? (
                  <span className="muted" style={{ fontSize: 13 }}>
                    No repositories found in your GitHub account.
                  </span>
                ) : (
                  <div className="col gap-2">
                    {repos.map((r) => {
                      const on = !!draft.repoIds[r.id];
                      return (
                        <button
                          type="button"
                          key={r.id}
                          onClick={() =>
                            setDraft((d) => ({
                              ...d,
                              repoIds: { ...d.repoIds, [r.id]: !d.repoIds[r.id] },
                            }))
                          }
                          className="row gap-3 between dda-wizard-repo-row"
                          data-on={on}
                        >
                          <div className="row gap-3" style={{ minWidth: 0 }}>
                            <Icon name="github" size={17} />
                            <div
                              className="col"
                              style={{ lineHeight: 1.3, minWidth: 0, textAlign: "left" }}
                            >
                              <span style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</span>
                              <span className="faint" style={{ fontSize: 11.5 }}>
                                {r.lang} · {r.kind}
                              </span>
                            </div>
                          </div>
                          <span className="row center dda-wizard-check" data-on={on}>
                            {on && <Icon name="check" size={13} />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </Field>
            </>
          )}
        </div>
      )}

      {stepIdx === 3 && (
        <RepoAnalysisStep
          repoFullName={primaryRepoFullName}
          accountId={effectiveGhAccountId}
          report={analysis}
          onReport={setAnalysis}
          planItems={planItems}
          onPlanItems={setPlanItems}
          infraRepo={draft.infraRepo}
          onInfraRepoChange={(v) => setDraft((d) => ({ ...d, infraRepo: v }))}
          availableInfraRepos={availableInfraRepos}
        />
      )}

      {stepIdx === 4 && (
        <div className="col gap-4">
          <p className="muted" style={{ fontSize: 13 }}>
            Turn on the environments you need. For each one, pick the repo
            branch it deploys from — the default matches the common convention
            when a matching branch exists (main → prod, staging → staging,
            develop → dev), otherwise falls back to the repo&apos;s default branch.
          </p>
          {branchesQ.isLoading && (
            <span className="muted" style={{ fontSize: 12.5 }}>
              Loading branches from {primaryRepoFullName ?? "the selected repo"}…
            </span>
          )}
          {branchesQ.isError && (
            <span style={{ fontSize: 12.5, color: "var(--warn, #f5a524)" }}>
              Couldn&apos;t load branches — you can still continue and type a branch
              name below.
            </span>
          )}
          <div className="col gap-2">
            {(Object.keys(ENV_META) as EnvKey[]).map((e) => {
              const on = draft.envs[e];
              const meta = ENV_META[e];
              const branchValue = draft.envBranches[e] ?? "";
              return (
                <div
                  key={e}
                  className="row gap-3 between dda-wizard-env-row"
                  data-on={on}
                  style={{ alignItems: "center", flexWrap: "wrap" }}
                >
                  <div className="row gap-3" style={{ alignItems: "center", flex: "1 1 200px" }}>
                    <span className={`dot ${meta.tone}`} />
                    <div className="col" style={{ lineHeight: 1.3 }}>
                      <span style={{ fontWeight: 700, fontSize: 13 }}>{meta.label}</span>
                      <span className="faint" style={{ fontSize: 11.5 }}>
                        {meta.autoDeploy ? "auto-deploy on push" : "manual promote (approval-gated)"}
                      </span>
                    </div>
                  </div>
                  <div
                    className="row gap-2"
                    style={{ alignItems: "center", flex: "1 1 260px", justifyContent: "flex-end" }}
                  >
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      deploys from
                    </span>
                    {on && availableBranches.length > 0 ? (
                      <Select
                        value={branchValue || (primaryRepoDefaultBranch ?? "")}
                        placeholder={primaryRepoDefaultBranch ?? "branch"}
                        options={availableBranches.map((b) => ({
                          value: b.name,
                          label: b.protected ? `${b.name} · protected` : b.name,
                        }))}
                        ariaLabel={`Branch for ${meta.label}`}
                        onValueChange={(v) =>
                          setDraft((d) => ({
                            ...d,
                            envBranches: { ...d.envBranches, [e]: v },
                          }))
                        }
                      />
                    ) : (
                      // No repo picked (or branches list failed) → free-text
                      // fallback so the step never traps the user. Server
                      // validates the branch at deploy time.
                      <Input
                        disabled={!on}
                        value={branchValue}
                        onChange={(ev) =>
                          setDraft((d) => ({
                            ...d,
                            envBranches: { ...d.envBranches, [e]: ev.target.value },
                          }))
                        }
                        placeholder={primaryRepoDefaultBranch ?? "main"}
                        style={{ maxWidth: 220 }}
                      />
                    )}
                    <button
                      type="button"
                      className={`btn ${on ? "outline" : "primary"} sm`}
                      onClick={() =>
                        setDraft((d) => ({ ...d, envs: { ...d.envs, [e]: !on } }))
                      }
                    >
                      {on ? "on" : "off"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <span className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            Branch pick is a display default — the deploy flow still confirms
            it at deploy time, so you can override any time without editing
            the env. Leave a branch blank to use the repo&apos;s default.
          </span>
        </div>
      )}

      {stepIdx === 1 && (
        <div className="col gap-4">
          <Field label="Cloud provider">
            <div className="row gap-2 wrap">
              {CLOUDS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`chip ${draft.cloud === c ? "active" : ""}`}
                  style={{ height: 38 }}
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      cloud: c,
                      // Reset region to the chosen cloud's typical default if
                      // the user hadn't customized it.
                      region: CLOUD_FIELD_META[c]?.regionPlaceholder ?? d.region,
                      // Switching provider clears the inline AWS connect state
                      // — the AWS card only applies when the AWS chip is active.
                      cloudConnected: c === "AWS" ? d.cloudConnected : false,
                      cloudSkipped: c === "AWS" ? d.cloudSkipped : false,
                    }))
                  }
                >
                  <Icon name={c === "Proxmox" ? "server" : "cloud"} size={15} />
                  {c === "Proxmox" ? "Proxmox (on-prem)" : c}
                </button>
              ))}
            </div>
          </Field>
          {(() => {
            const meta = CLOUD_FIELD_META[draft.cloud] ?? CLOUD_FIELD_META.AWS;
            return (
              <>
                <div style={{ maxWidth: 320 }}>
                  <Field
                    label={draft.cloud === "Proxmox" ? "Default node" : "Default region"}
                    hint={
                      draft.cloud === "Proxmox"
                        ? "Proxmox node new VMs land on (e.g. pve)."
                        : "You can change this per environment later."
                    }
                  >
                    {meta.regions.length > 0 ? (
                      <Select
                        value={draft.region}
                        onValueChange={(v) => setDraft((d) => ({ ...d, region: v }))}
                        options={meta.regions}
                        ariaLabel="Default region"
                      />
                    ) : (
                      <Input
                        value={draft.region}
                        onChange={(e) => setDraft((d) => ({ ...d, region: e.target.value }))}
                        placeholder={meta.regionPlaceholder}
                      />
                    )}
                  </Field>
                </div>
                <div className="row gap-2 dda-wizard-iam-note">
                  <Icon name="shield" size={16} style={{ flex: "none" }} />
                  <span style={{ fontSize: 12.5 }}>{meta.note}</span>
                </div>

                {/* AWS: inline Connect &amp; verify (required-but-skippable).
                    Other clouds defer to the Cloud providers tab — they need
                    a projectSlug the wizard doesn't have yet. */}
                {draft.cloud === "AWS" && !draft.cloudConnected && !draft.cloudSkipped && (
                  <div
                    className="col gap-2"
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      padding: 12,
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 13 }}>Connect your AWS account</span>
                    <Field label="IAM role ARN" required>
                      <Input
                        className="mono"
                        value={awsRoleArn}
                        onChange={(e) => setAwsRoleArn(e.target.value)}
                        placeholder="arn:aws:iam::123456789012:role/deep-agent"
                      />
                    </Field>
                    <Field
                      label="External ID override (optional)"
                      hint="Leave blank to use the default DeepAgent-generated ExternalId shown on the AWS trust-policy help. Paste your existing one if the role's trust policy uses a different value."
                    >
                      <Input
                        className="mono"
                        value={awsExternalIdOverride}
                        onChange={(e) => setAwsExternalIdOverride(e.target.value)}
                        placeholder="dda-<hex>"
                      />
                    </Field>
                    <div className="row gap-2" style={{ alignItems: "center" }}>
                      <Btn
                        variant="primary"
                        icon="check"
                        loading={connectAws.isPending}
                        disabled={!awsRoleArn.trim() || connectAws.isPending}
                        onClick={async () => {
                          setAwsConnectMsg(null);
                          try {
                            await connectAws.mutateAsync({
                              roleArn: awsRoleArn.trim(),
                              region: draft.region.trim() || "us-east-1",
                              externalId: awsExternalIdOverride.trim() || undefined,
                              // No projectSlug — project doesn't exist yet. The
                              // provider is created user-scoped and will be
                              // re-referenced (by role ARN) after project create.
                            });
                            setAwsConnectMsg("✅ Connected. Continue to pick your repo.");
                            setDraft((d) => ({ ...d, cloudConnected: true }));
                          } catch (e) {
                            setAwsConnectMsg(
                              e instanceof Error
                                ? `❌ ${e.message}`
                                : "❌ AWS connect failed — check the role ARN + trust policy, or skip and connect later.",
                            );
                          }
                        }}
                      >
                        Connect &amp; verify
                      </Btn>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => {
                          setDraft((d) => ({ ...d, cloudSkipped: true }));
                          setAwsConnectMsg(
                            "Skipped — you can connect AWS from the project's Cloud providers tab after creation.",
                          );
                        }}
                      >
                        I&apos;ll connect later
                      </button>
                    </div>
                    {awsConnectMsg && (
                      <span
                        style={{
                          fontSize: 12,
                          color: awsConnectMsg.startsWith("❌")
                            ? "var(--danger)"
                            : "var(--muted)",
                        }}
                      >
                        {awsConnectMsg}
                      </span>
                    )}
                  </div>
                )}

                {/* AWS connected/skipped confirmation strip. */}
                {draft.cloud === "AWS" && (draft.cloudConnected || draft.cloudSkipped) && (
                  <div
                    className="row gap-2"
                    style={{
                      alignItems: "center",
                      border: `1px solid ${draft.cloudConnected ? "var(--ok, #30a46c)" : "var(--border)"}`,
                      borderRadius: 10,
                      padding: "10px 12px",
                      fontSize: 12.5,
                    }}
                  >
                    <Icon
                      name={draft.cloudConnected ? "check" : "clock"}
                      size={14}
                      style={{
                        flex: "none",
                        color: draft.cloudConnected ? "var(--ok, #30a46c)" : undefined,
                      }}
                    />
                    <span style={{ flex: 1 }}>
                      {draft.cloudConnected
                        ? `AWS connected — role ${awsRoleArn || "assumed"} in ${draft.region}.`
                        : "AWS connect skipped — will be available from the Cloud providers tab after creation."}
                    </span>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => {
                        setDraft((d) => ({ ...d, cloudConnected: false, cloudSkipped: false }));
                        setAwsConnectMsg(null);
                      }}
                    >
                      Change
                    </button>
                  </div>
                )}

                {/* GCP / Azure / Proxmox — inline connect deferred (needs a
                    projectSlug we don't have yet). Note that this doesn't
                    block Continue for those clouds. */}
                {draft.cloud !== "AWS" && (
                  <div
                    className="row gap-2"
                    style={{
                      alignItems: "center",
                      border: "1px dashed var(--border)",
                      borderRadius: 10,
                      padding: "10px 12px",
                      fontSize: 12.5,
                    }}
                  >
                    <Icon name="clock" size={14} style={{ flex: "none" }} />
                    <span>
                      {draft.cloud === "Proxmox" ? (
                        <>
                          Proxmox server connection (host URL + API token) happens on the
                          project&apos;s <b>Cloud providers</b> tab right after creation — it needs
                          the project to exist first.
                        </>
                      ) : (
                        <>
                          {draft.cloud} account connection happens on the project&apos;s{" "}
                          <b>Cloud providers</b> tab right after creation — it needs the project to
                          exist first.
                        </>
                      )}
                    </span>
                  </div>
                )}
              </>
            );
          })()}
          <div className="card dda-wizard-summary">
            <span
              className="faint"
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Summary
            </span>
            <div className="row gap-3" style={{ marginTop: 10, alignItems: "center" }}>
              <ProjectAvatar name={initial} hue={draft.hue} size={36} radius={10} />
              <div className="col" style={{ lineHeight: 1.4 }}>
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>
                  {draft.name.trim() || "Untitled project"}
                </span>
                <span className="faint" style={{ fontSize: 11.5 }}>
                  {selectedRepoIds.length} {selectedRepoIds.length === 1 ? "repo" : "repos"} ·{" "}
                  {selectedEnvs.length} {selectedEnvs.length === 1 ? "environment" : "environments"}{" "}
                  · {draft.cloud}
                </span>
              </div>
              <div style={{ marginLeft: "auto" }}>
                <Badge tone="accent">
                  Step {stepIdx + 1} / {STEPS.length}
                </Badge>
              </div>
            </div>
          </div>
        </div>
      )}

      {serverError && (
        <p style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 12 }} role="alert">
          {serverError}
        </p>
      )}
    </Modal>
  );
}

/**
 * Picker for the Team that will own the new project.
 *
 * Only offers teams the caller LEADS — a member can't create projects, so
 * offering non-lead teams would just produce a 403 after Submit. When the
 * user leads exactly one team, it's preselected; otherwise the picker forces
 * a choice. Empty state points at Create Team so a first-time user isn't
 * stuck (every account is backfilled with a personal team, so this shouldn't
 * fire in practice — kept as a defensive fallback).
 */
function TeamPicker({ value, onChange }: { value: string; onChange: (slug: string) => void }) {
  const { data, isLoading } = useQuery<{ teams: Array<{ slug: string; name: string; role: "lead" | "member" }> }>({
    queryKey: ["teams", "entities"],
    queryFn: () => api.get("/teams/entities"),
    staleTime: 30_000,
  });
  const leadTeams = (data?.teams ?? []).filter((t) => t.role === "lead");

  useEffect(() => {
    if (!value && leadTeams.length === 1) onChange(leadTeams[0]!.slug);
  }, [value, leadTeams, onChange]);

  if (isLoading) {
    return <Field label="Team"><Input value="loading teams…" disabled /></Field>;
  }
  if (leadTeams.length === 0) {
    return (
      <Field
        label="Team"
        hint="You don't lead any team yet. Create one from the Teams page, then come back."
      >
        <Input value="No teams you lead" disabled />
      </Field>
    );
  }
  return (
    <Field
      label="Team"
      required
      hint="Only leads can create projects. Members join the project through their team."
    >
      <Select
        value={value}
        placeholder="Pick a team…"
        options={leadTeams.map((t) => ({ value: t.slug, label: t.name }))}
        onValueChange={onChange}
      />
    </Field>
  );
}
