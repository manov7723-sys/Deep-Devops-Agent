"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Btn, Field, Icon, Modal, Select } from "@/components/ui";
import { api } from "@/lib/api/client";
import { useProviderRepos, type GitProvider } from "@/hooks/queries/repos";
import { useConnectedOAuthAccounts } from "@/hooks/queries/account";

const PROVIDER_LABEL: Record<GitProvider, string> = { github: "GitHub", gitlab: "GitLab" };

export interface AttachReposModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
  /** Set of repoIds (DeepAgent Repo.id) already attached so we can hide them. */
  alreadyAttachedFullNames?: ReadonlySet<string>;
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
 * Attach one or more GitHub or GitLab repos to an existing project. Each pick
 * goes through `POST /repos` (upserts Repo by ownerId+fullName+provider) then
 * `POST /projects/<slug>/repos` (creates the ProjectRepo row).
 *
 * Failures are reported per-repo so the user can retry just that one
 * without losing the rest.
 */
export function AttachReposModal({
  open,
  onOpenChange,
  projectSlug,
  alreadyAttachedFullNames,
}: AttachReposModalProps) {
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
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const label = PROVIDER_LABEL[provider];

  // Reset picks whenever the modal opens; default to a connected provider.
  useEffect(() => {
    if (open) {
      setPicked({});
      setServerError(null);
      setAccountId(null);
      setProvider(hasGithub ? "github" : hasGitlab ? "gitlab" : "github");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const visibleRepos = useMemo<GitHubRow[]>(() => {
    if (!ghQuery.data) return [];
    if (!alreadyAttachedFullNames) return ghQuery.data;
    return ghQuery.data.filter((r) => !alreadyAttachedFullNames.has(r.fullName));
  }, [ghQuery.data, alreadyAttachedFullNames]);

  const attach = useMutation({
    mutationFn: async (repos: GitHubRow[]) => {
      const results: Array<{ ok: boolean; fullName: string; code?: string }> = [];
      for (const r of repos) {
        try {
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
          // duplicate is fine — re-resolve using a fresh GET.
          let repoId = create.repo?.id ?? null;
          if (!repoId) {
            const all = await api.get<Array<{ id: string; fullName: string; provider?: GitProvider }>>("/repos");
            repoId = all.find((x) => x.fullName === r.fullName && (x.provider ?? "github") === provider)?.id ?? null;
          }
          if (!repoId) {
            results.push({ ok: false, fullName: r.fullName, code: "repo_resolve_failed" });
            continue;
          }
          // Step 2: attach to project.
          const link = await api.post<{ ok: boolean; code?: string }>(
            `/projects/${projectSlug}/repos`,
            { repoId },
          );
          results.push({ ok: link.ok, fullName: r.fullName, code: link.ok ? undefined : link.code });
        } catch (err) {
          results.push({
            ok: false,
            fullName: r.fullName,
            code: err instanceof Error ? err.message : "unknown",
          });
        }
      }
      return results;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["p", projectSlug] });
    },
  });

  const pickedRepos = visibleRepos.filter((r) => picked[r.id]);
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
      title="Attach repositories"
      description="Pick GitHub or GitLab repos to attach to this project."
      width={620}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Btn>
          <Btn
            variant="primary"
            icon="link"
            loading={attach.isPending}
            disabled={pickedRepos.length === 0}
            onClick={async () => {
              setServerError(null);
              try {
                const results = await attach.mutateAsync(pickedRepos);
                const failures = results.filter((r) => !r.ok);
                if (failures.length === 0) {
                  onOpenChange(false);
                } else {
                  setServerError(
                    `Attached ${results.length - failures.length}/${results.length}. Failed: ${failures.map((f) => f.fullName).join(", ")}`,
                  );
                }
              } catch (e) {
                setServerError(e instanceof Error ? e.message : "Attach failed.");
              }
            }}
          >
            Attach {pickedRepos.length > 0 ? `(${pickedRepos.length})` : ""}
          </Btn>
        </>
      }
    >
      {hasGithub && hasGitlab && (
        <Field label="Provider" hint="Which git host to attach repos from.">
          <div className="row gap-2 wrap">
            {(["github", "gitlab"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={`chip ${provider === p ? "active" : ""}`}
                style={{ height: 34 }}
                onClick={() => { setProvider(p); setAccountId(null); setPicked({}); }}
              >
                <Icon name={p} size={14} /> {PROVIDER_LABEL[p]}
              </button>
            ))}
          </div>
        </Field>
      )}

      {providerAccounts.length > 1 && (
        <Field
          label={`${label} account`}
          hint="Repos under the picked account will be saved with that identity."
        >
          <Select
            value={effectiveAccountId ?? ""}
            onValueChange={(v) => {
              setAccountId(v || null);
              setPicked({});
            }}
            ariaLabel={`${label} account`}
            options={providerAccounts.map((a) => ({
              value: a.id,
              label: a.login ? `@${a.login}` : `id:${a.providerAccountId.slice(0, 8)}`,
            }))}
          />
        </Field>
      )}

      <Field label="Repositories" hint={`${pickedRepos.length} selected`}>
        {ghQuery.isLoading ? (
          <span className="muted" style={{ fontSize: 13 }}>Loading your {label} repositories…</span>
        ) : ghError ? (
          <div
            className="col gap-2"
            style={{ border: "1px dashed var(--border)", borderRadius: 8, padding: 12, fontSize: 13 }}
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
              href={`/api/v1/auth/oauth/${provider}/start?next=${encodeURIComponent(`/p/${projectSlug}/cicd?tab=repos`)}`}
            >
              <Icon name={provider} size={14} />
              {ghCode?.endsWith("_not_connected") ? `Connect ${label}` : `Reconnect ${label}`}
            </a>
          </div>
        ) : visibleRepos.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            All your {label} repos are already attached to this project.
          </span>
        ) : (
          <div className="col gap-2" style={{ maxHeight: 320, overflow: "auto" }}>
            {visibleRepos.map((r) => {
              const on = !!picked[r.id];
              return (
                <button
                  type="button"
                  key={r.id}
                  onClick={() => setPicked((p) => ({ ...p, [r.id]: !p[r.id] }))}
                  className="row gap-3 between dda-wizard-repo-row"
                  data-on={on}
                >
                  <div className="row gap-3" style={{ minWidth: 0 }}>
                    <Icon name={provider} size={17} />
                    <div className="col" style={{ lineHeight: 1.3, minWidth: 0, textAlign: "left" }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{r.fullName}</span>
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
