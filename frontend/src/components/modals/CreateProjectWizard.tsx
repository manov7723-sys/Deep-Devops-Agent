"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Btn,
  Field,
  Icon,
  Input,
  Modal,
  Select,
  Textarea,
  Toggle,
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

const STEPS = ["Details", "Repository", "Environments", "Cloud"] as const;
type EnvKey = "alpha" | "beta" | "release";

const ENV_META: Record<EnvKey, { tone: "info" | "warn" | "ok"; branch: string; label: string }> = {
  alpha: { tone: "info", branch: "develop", label: "Alpha" },
  beta: { tone: "warn", branch: "release/*", label: "Beta" },
  release: { tone: "ok", branch: "main", label: "Release" },
};

const CLOUDS = ["AWS", "GCP", "Azure"] as const;

/**
 * Per-provider strings for the wizard's step 4. The wizard only PICKS the cloud
 * (and a default region) here — the actual account connection (IAM role + STS
 * ExternalId on AWS, service account on GCP, service principal on Azure) is done
 * afterward on the project's "Cloud providers" tab (ConnectCloudModal), or from
 * chat via the ```cloud-connect``` fence (CloudConnectBox).
 */
const CLOUD_FIELD_META: Record<string, { regionPlaceholder: string; note: string }> = {
  AWS: {
    regionPlaceholder: "us-east-1",
    note: "Deep Agent will assume a scoped AWS IAM role via STS (no long-lived keys).",
  },
  GCP: {
    regionPlaceholder: "us-central1",
    note: "Deep Agent will impersonate a GCP service account (workload-identity supported).",
  },
  Azure: {
    regionPlaceholder: "eastus",
    note: "Deep Agent will sign in as an Azure service principal.",
  },
  Proxmox: {
    regionPlaceholder: "pve",
    note: "On-prem: after creating the project, connect your Proxmox server (host URL + API token) on the Cloud providers tab, then create VMs with Terraform.",
  },
};

type Draft = {
  name: string;
  description: string;
  hue: number;
  ghConnected: boolean;
  /** Which connected GitHub identity (OAuthAccount.id) this project pulls repos from. */
  ghAccountId: string | null;
  repoIds: Record<string, boolean>;
  envs: Record<EnvKey, boolean>;
  // Step 4 is selection-only: which cloud this project targets + a default
  // region. No account is connected here — that happens on the Cloud tab.
  cloud: string;
  region: string;
  /** First-screen choice: cloud (AWS/GCP/Azure) vs on-prem (Proxmox). null = not chosen yet. */
  mode: "cloud" | "onprem" | null;
};

const DEFAULT_DRAFT: Draft = {
  name: "",
  description: "",
  hue: 285,
  ghConnected: false,
  ghAccountId: null,
  repoIds: {},
  // Only Release is on by default — matches the common "one repo, one branch
  // (main)" reality of a fresh project. Users opt-in to Alpha/Beta only when
  // they actually maintain matching long-lived branches.
  envs: { alpha: false, beta: false, release: true },
  cloud: "AWS",
  region: "us-east-1",
  mode: null,
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
  const [serverError, setServerError] = useState<string | null>(null);
  const [ghNote, setGhNote] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);

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
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { source?: string; status?: string } | null;
      if (!data || data.source !== "dda-oauth") return;
      if (data.status === "connected") {
        qc.invalidateQueries({ queryKey: ["account", "oauth-accounts"] });
        setDraft((d) => ({ ...d, ghConnected: true }));
        setGhNote(null);
      } else if (data.status === "needs_login") {
        setGhNote("Please sign in to the app first, then connect GitHub.");
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [qc]);

  // Active account drives which token the repo-list query uses. Defaults to
  // the draft's chosen one (so it persists across re-opens), then falls back
  // to the first connected GitHub account.
  const effectiveGhAccountId = draft.ghAccountId ?? githubAccounts[0]?.id ?? null;
  const ghQuery = useGitHubRepos(open && !!effectiveGhAccountId, effectiveGhAccountId);
  const ghMe = useGitHubMe(open && !!effectiveGhAccountId, effectiveGhAccountId);
  const repos = ghQuery.data ?? [];
  const repoError = ghQuery.error;

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
      case 0:
        return draft.name.trim().length > 0;
      case 1:
        return draft.ghConnected && selectedRepoIds.length > 0;
      case 2:
        return selectedEnvs.length > 0;
      case 3:
        return true;
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

      const envOrder: EnvKey[] = ["alpha", "beta", "release"];
      const selectedEnvs: EnvChoiceInput[] = envOrder
        .filter((k) => draft.envs[k])
        .map((k, i) => ({
          key: k,
          name: ENV_META[k].label,
          isProduction: k === "release",
          autoDeploy: k !== "release",
          promotionRank: i,
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
        repos: selectedRepos,
        envs: selectedEnvs,
        cloud: null,
        // Record which cloud the project targets so the Connect-provider UI
        // locks to it. Selection-only — no provider is provisioned here.
        cloudKind: draft.cloud.toLowerCase() as "aws" | "gcp" | "azure" | "proxmox",
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
          {draft.mode && (
            <Btn
              variant="ghost"
              icon="chevL"
              style={{ marginRight: "auto" }}
              onClick={() =>
                stepIdx === 0 ? setDraft((d) => ({ ...d, mode: null })) : onStepChange(stepIdx)
              }
            >
              Back
            </Btn>
          )}
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Btn>
          {draft.mode && (
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
          )}
        </>
      }
    >
      {/* First screen: where will this project run? Cloud runs the usual
          wizard; on-prem targets a self-hosted Proxmox server. */}
      {!draft.mode && (
        <div className="col gap-3">
          <p className="muted" style={{ fontSize: 13 }}>
            Where will this project run? Pick one — you&apos;ll connect the account or server in the
            following steps.
          </p>
          <div className="row gap-3 wrap">
            {(
              [
                { m: "cloud", icon: "cloud", title: "Cloud", sub: "AWS · GCP · Azure" },
                { m: "onprem", icon: "server", title: "On-prem", sub: "Proxmox VE (self-hosted)" },
              ] as const
            ).map((o) => (
              <button
                key={o.m}
                type="button"
                onClick={() =>
                  setDraft((d) =>
                    o.m === "onprem"
                      ? { ...d, mode: "onprem", cloud: "Proxmox", region: "pve" }
                      : { ...d, mode: "cloud", cloud: "AWS", region: "us-east-1" },
                  )
                }
                className="col gap-2"
                style={{
                  flex: "1 1 200px",
                  alignItems: "flex-start",
                  textAlign: "left",
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  padding: 16,
                  cursor: "pointer",
                  background: "var(--surface-2, transparent)",
                }}
              >
                <Icon name={o.icon} size={22} />
                <strong style={{ fontSize: 15 }}>{o.title}</strong>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {o.sub}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {draft.mode && <WizardSteps steps={STEPS as unknown as string[]} current={stepIdx} />}

      {draft.mode && stepIdx === 0 && (
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
        </div>
      )}

      {draft.mode && stepIdx === 1 && (
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

      {draft.mode && stepIdx === 2 && (
        <div className="col gap-4">
          <p className="muted" style={{ fontSize: 13 }}>
            Each environment listens to a specific branch. Pushes to that branch trigger a deploy.{" "}
            <b>Release</b> (your <span className="mono">main</span>/production) is on by default;
            only enable Alpha or Beta if your repo actually maintains long-lived{" "}
            <span className="mono">develop</span> / <span className="mono">release/*</span>{" "}
            branches. You can add more envs later.
          </p>
          <div className="col gap-2">
            {(Object.keys(ENV_META) as EnvKey[]).map((e) => {
              const on = draft.envs[e];
              const meta = ENV_META[e];
              return (
                <div key={e} className="row gap-3 between dda-wizard-env-row" data-on={on}>
                  <div className="row gap-3">
                    <span className={`dot ${meta.tone}`} />
                    <div className="col" style={{ lineHeight: 1.3 }}>
                      <span style={{ fontWeight: 700, fontSize: 13 }}>{meta.label}</span>
                      <span className="faint mono" style={{ fontSize: 11.5 }}>
                        {meta.branch}
                      </span>
                    </div>
                  </div>
                  <Toggle
                    checked={on}
                    onCheckedChange={(v) =>
                      setDraft((d) => ({ ...d, envs: { ...d.envs, [e]: v } }))
                    }
                    ariaLabel={meta.label}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {draft.mode && stepIdx === 3 && (
        <div className="col gap-4">
          {draft.mode === "onprem" ? (
            <Field label="On-prem infrastructure">
              <div
                className="row gap-2"
                style={{
                  alignItems: "center",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: 12,
                }}
              >
                <Icon name="server" size={18} style={{ flex: "none" }} />
                <span style={{ fontSize: 13 }}>
                  <strong>Proxmox VE</strong> — after creating the project, connect your server
                  (host URL + API token) on the <b>Cloud providers</b> tab, then create VMs with
                  Terraform.
                </span>
              </div>
            </Field>
          ) : (
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
                      }))
                    }
                  >
                    <Icon name="cloud" size={15} />
                    {c}
                  </button>
                ))}
              </div>
            </Field>
          )}
          {(() => {
            const meta = CLOUD_FIELD_META[draft.cloud] ?? CLOUD_FIELD_META.AWS;
            return (
              <>
                <div style={{ maxWidth: 240 }}>
                  <Field
                    label={draft.cloud === "Proxmox" ? "Default node" : "Default region"}
                    hint={
                      draft.cloud === "Proxmox"
                        ? "Proxmox node new VMs land on (e.g. pve)."
                        : "You can change this per environment later."
                    }
                  >
                    <Input
                      value={draft.region}
                      onChange={(e) => setDraft((d) => ({ ...d, region: e.target.value }))}
                      placeholder={meta.regionPlaceholder}
                    />
                  </Field>
                </div>
                <div className="row gap-2 dda-wizard-iam-note">
                  <Icon name="shield" size={16} style={{ flex: "none" }} />
                  <span style={{ fontSize: 12.5 }}>
                    {meta.note} You&apos;ll connect the account itself on the project&apos;s{" "}
                    <b>Cloud providers</b> tab right after creation.
                  </span>
                </div>
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
