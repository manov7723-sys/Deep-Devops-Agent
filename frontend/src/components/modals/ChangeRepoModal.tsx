"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, Btn, Field, Icon, Modal, Select } from "@/components/ui";
import { api } from "@/lib/api/client";
import { useProviderRepos, type GitProvider } from "@/hooks/queries/repos";
import { useConnectedOAuthAccounts } from "@/hooks/queries/account";

const PROVIDER_LABEL: Record<GitProvider, string> = { github: "GitHub", gitlab: "GitLab" };

export interface ChangeRepoModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
  /** fullName of the repo currently set on the project, to highlight it. */
  currentFullName?: string | null;
}

type GitHubRow = {
  id: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  lang: string;
  kind: "private" | "public";
  providerRepoId?: string;
};

/**
 * Change the project's repository (GitHub or GitLab). Single-select: the picked
 * repo becomes the project's ONE repo (every feature — Automation, CI, scans —
 * then uses it). Upserts the Repo row (`POST /repos`) then replaces the
 * project's repo set (`PUT /projects/<slug>/repos`).
 */
export function ChangeRepoModal({
  open,
  onOpenChange,
  projectSlug,
  currentFullName,
}: ChangeRepoModalProps) {
  const qc = useQueryClient();
  const accountsQuery = useConnectedOAuthAccounts();
  const allAccounts = accountsQuery.data ?? [];
  const hasGithub = allAccounts.some((a) => a.provider === "github");
  const hasGitlab = allAccounts.some((a) => a.provider === "gitlab");

  const [provider, setProvider] = useState<GitProvider>("github");
  const providerAccounts = allAccounts.filter((a) => a.provider === provider);
  const [accountId, setAccountId] = useState<string | null>(null);
  const effectiveAccountId = accountId ?? providerAccounts[0]?.id ?? null;
  const ghQuery = useProviderRepos(provider, open && !!effectiveAccountId, effectiveAccountId);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const label = PROVIDER_LABEL[provider];

  useEffect(() => {
    if (open) {
      setPickedId(null);
      setServerError(null);
      setAccountId(null);
      setProvider(hasGithub ? "github" : hasGitlab ? "gitlab" : "github");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const repos = ghQuery.data ?? [];
  const picked = repos.find((r) => r.id === pickedId) ?? null;

  const change = useMutation({
    mutationFn: async (r: GitHubRow) => {
      // Step 1: upsert the Repo row (idempotent on ownerId+fullName).
      const create = await api.post<{ ok: boolean; repo?: { id: string }; code?: string }>(
        "/repos",
        {
          fullName: r.fullName,
          description: "",
          lang: r.lang,
          kind: "Service",
          defaultBranch: r.defaultBranch,
          visibility: r.kind,
          oauthAccountId: effectiveAccountId ?? undefined,
          provider,
          providerRepoId: r.providerRepoId,
        },
      );
      let repoId = create.repo?.id ?? null;
      if (!repoId) {
        const all =
          await api.get<Array<{ id: string; fullName: string; provider?: GitProvider }>>("/repos");
        repoId =
          all.find((x) => x.fullName === r.fullName && (x.provider ?? "github") === provider)?.id ??
          null;
      }
      if (!repoId) throw new Error("Couldn't resolve the repository. Try again.");
      // Step 2: make it the project's single repo.
      const res = await api.put<{ ok: boolean; code?: string }>(`/projects/${projectSlug}/repos`, {
        repoId,
      });
      if (!res.ok) throw new Error(res.code || "Could not set the project repository.");
      return r.fullName;
    },
    onSuccess: async () => {
      // Refresh everything that reads the project's repo.
      await qc.invalidateQueries({ queryKey: ["p", projectSlug] });
      onOpenChange(false);
    },
    onError: (e) => setServerError(e instanceof Error ? e.message : "Change failed."),
  });

  const ghError = ghQuery.error;
  const ghCode =
    (ghError as { details?: unknown } | null)?.details &&
    typeof (ghError as { details?: unknown }).details === "string"
      ? (() => {
          try {
            const j = JSON.parse((ghError as { details: string }).details);
            return typeof j?.code === "string" ? (j.code as string) : null;
          } catch {
            return null;
          }
        })()
      : null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Change project repository"
      description="Pick the repository this project should use. It applies across the whole project — Automation, CI and security scans."
      width={620}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon={provider}
            loading={change.isPending}
            disabled={!picked || change.isPending || picked.fullName === currentFullName}
            onClick={() => {
              setServerError(null);
              if (picked) change.mutate(picked);
            }}
          >
            {picked && picked.fullName === currentFullName
              ? "Already the project repo"
              : "Use this repo"}
          </Btn>
        </>
      }
    >
      {hasGithub && hasGitlab && (
        <Field label="Provider" hint="Which git host to pick the repo from.">
          <div className="row gap-2 wrap">
            {(["github", "gitlab"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={`chip ${provider === p ? "active" : ""}`}
                style={{ height: 34 }}
                onClick={() => {
                  setProvider(p);
                  setAccountId(null);
                  setPickedId(null);
                }}
              >
                <Icon name={p} size={14} /> {PROVIDER_LABEL[p]}
              </button>
            ))}
          </div>
        </Field>
      )}

      {providerAccounts.length > 1 && (
        <Field label={`${label} account`} hint="Choose which connected account to list repos from.">
          <Select
            value={effectiveAccountId ?? ""}
            onValueChange={(v) => {
              setAccountId(v || null);
              setPickedId(null);
            }}
            ariaLabel={`${label} account`}
            options={providerAccounts.map((a) => ({
              value: a.id,
              label: a.login ? `@${a.login}` : `id:${a.providerAccountId.slice(0, 8)}`,
            }))}
          />
        </Field>
      )}

      <Field label="Repository" hint={picked ? picked.fullName : "Select one"}>
        {ghQuery.isLoading ? (
          <span className="muted" style={{ fontSize: 13 }}>
            Loading your {label} repositories…
          </span>
        ) : ghError ? (
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
              {ghCode?.endsWith("_not_connected")
                ? `${label} isn't connected yet`
                : ghCode === "github_scope_insufficient"
                  ? `Reconnect ${label} to grant repo access`
                  : `Couldn't load your ${label} repos`}
            </span>
            <a
              className="btn outline sm"
              style={{ width: "fit-content", textDecoration: "none" }}
              href={`/api/v1/auth/oauth/${provider}/start?next=${encodeURIComponent(`/p/${projectSlug}/github`)}`}
            >
              <Icon name={provider} size={14} />
              {ghCode?.endsWith("_not_connected") ? `Connect ${label}` : `Reconnect ${label}`}
            </a>
          </div>
        ) : repos.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            No repositories found for this account.
          </span>
        ) : (
          <div className="col gap-2" style={{ maxHeight: 320, overflow: "auto" }}>
            {repos.map((r) => {
              const on = pickedId === r.id;
              const isCurrent = r.fullName === currentFullName;
              return (
                <button
                  type="button"
                  key={r.id}
                  onClick={() => setPickedId(r.id)}
                  className="row gap-3 between dda-wizard-repo-row"
                  data-on={on}
                >
                  <div className="row gap-3" style={{ minWidth: 0 }}>
                    <Icon name={provider} size={17} />
                    <div
                      className="col"
                      style={{ lineHeight: 1.3, minWidth: 0, textAlign: "left" }}
                    >
                      <span className="row gap-2" style={{ alignItems: "center" }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{r.fullName}</span>
                        {isCurrent && <Badge tone="ok">current</Badge>}
                      </span>
                      <span className="faint" style={{ fontSize: 11.5 }}>
                        {r.lang} · {r.kind} · {r.defaultBranch}
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

      {serverError && (
        <p style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 8 }} role="alert">
          {serverError}
        </p>
      )}
    </Modal>
  );
}
