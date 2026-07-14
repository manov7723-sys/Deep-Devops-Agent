"use client";

/**
 * Source control — project-workspace section to manage the GitHub and GitLab
 * accounts the agent uses to read repos and open pull/merge requests. Each
 * provider gets its own connect / reconnect / disconnect section. Connect reuses
 * the OAuth popup flow (start route with `popup=1`; the callback closes it and
 * postMessages back), identical to connecting while creating a project.
 */
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Avatar, Badge, Block, Btn, PageHead } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import { useConnectedOAuthAccounts, useDisconnectOAuthAccount } from "@/hooks/queries/account";
import { useProjectRepos } from "@/hooks/queries/project";
import { ChangeRepoModal } from "@/components/modals/ChangeRepoModal";

const OAUTH_ACCOUNTS_KEY = ["account", "oauth-accounts"];

type Provider = "github" | "gitlab";
const PROVIDER_LABEL: Record<Provider, string> = { github: "GitHub", gitlab: "GitLab" };

export function GithubConnectionClient({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const accountsQuery = useConnectedOAuthAccounts();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [repoModalOpen, setRepoModalOpen] = useState(false);

  // Receive the popup's result and refresh the connected accounts in place.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { source?: string; status?: string } | null;
      if (!data || data.source !== "dda-oauth") return;
      if (data.status === "connected") {
        qc.invalidateQueries({ queryKey: OAUTH_ACCOUNTS_KEY });
        setNote("Connected.");
        setError(null);
      } else if (data.status === "needs_login") {
        setError("Please sign in to the app first, then connect.");
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [qc]);

  const anyConnected = (accountsQuery.data ?? []).some(
    (a) => a.provider === "github" || a.provider === "gitlab",
  );

  const reposQuery = useProjectRepos(slug);
  const projectRepos = reposQuery.data ?? [];
  const activeRepo = projectRepos[0] ?? null;
  const activeRepoView = activeRepo as unknown as {
    fullName: string;
    defaultBranch?: string;
    visibility?: string;
    provider?: Provider;
  } | null;
  const repoIcon: Provider = activeRepoView?.provider === "gitlab" ? "gitlab" : "github";

  return (
    <div className="col gap-4">
      <PageHead
        title="Source control"
        sub="Manage the GitHub and GitLab accounts the agent uses to read your repositories and open pull / merge requests."
      />

      {error && (
        <Badge tone="danger" icon="alert">
          {error}
        </Badge>
      )}
      {!error && note && (
        <Badge tone="ok" icon="check">
          {note}
        </Badge>
      )}

      <ProviderSection slug={slug} provider="github" onNote={setNote} onError={setError} />
      <ProviderSection slug={slug} provider="gitlab" onNote={setNote} onError={setError} />

      {anyConnected && (
        <Block>
          <Block.Header>
            <Block.Title sub="The repository this project uses everywhere — Automation, CI and security scans. Changing it applies across the whole project.">
              Project repository
            </Block.Title>
          </Block.Header>
          <Block.Body>
            <div className="row between gap-3 wrap" style={{ alignItems: "center" }}>
              {reposQuery.isLoading ? (
                <span className="muted" style={{ fontSize: 13 }}>
                  Loading…
                </span>
              ) : activeRepoView ? (
                <div className="row gap-3" style={{ alignItems: "center", minWidth: 0 }}>
                  <Icon name={repoIcon} size={20} />
                  <div className="col" style={{ gap: 3, minWidth: 0 }}>
                    <div className="row gap-2" style={{ alignItems: "center" }}>
                      <strong style={{ fontSize: 14 }}>{activeRepoView.fullName}</strong>
                      {activeRepoView.visibility && (
                        <Badge tone={activeRepoView.visibility === "Private" ? "warn" : "default"}>
                          {activeRepoView.visibility}
                        </Badge>
                      )}
                      {projectRepos.length > 1 && (
                        <Badge tone="info">
                          +{projectRepos.length - 1} more — Change repo consolidates to one
                        </Badge>
                      )}
                    </div>
                    <span className="faint" style={{ fontSize: 12 }}>
                      Default branch: {activeRepoView.defaultBranch || "—"}
                    </span>
                  </div>
                </div>
              ) : (
                <span className="muted" style={{ fontSize: 13 }}>
                  No repository set for this project yet.
                </span>
              )}

              <Btn
                variant="outline"
                size="sm"
                icon={repoIcon}
                onClick={() => setRepoModalOpen(true)}
              >
                {activeRepoView ? "Change repo" : "Set repository"}
              </Btn>
            </div>
          </Block.Body>
        </Block>
      )}

      <ChangeRepoModal
        open={repoModalOpen}
        onOpenChange={setRepoModalOpen}
        projectSlug={slug}
        currentFullName={activeRepoView?.fullName ?? null}
      />

      <p className="faint row gap-2" style={{ fontSize: 12, alignItems: "flex-start" }}>
        <Icon name="lock" />
        <span>
          Disconnecting removes the agent&apos;s access to that provider&apos;s repositories. You
          can reconnect at any time — it&apos;s the same flow used when creating a project. If a
          provider is your only sign-in method, set a password first or it can&apos;t be
          disconnected.
        </span>
      </p>
    </div>
  );
}

function ProviderSection({
  slug,
  provider,
  onNote,
  onError,
}: {
  slug: string;
  provider: Provider;
  onNote: (v: string | null) => void;
  onError: (v: string | null) => void;
}) {
  const qc = useQueryClient();
  const accountsQuery = useConnectedOAuthAccounts();
  const disconnect = useDisconnectOAuthAccount();
  const label = PROVIDER_LABEL[provider];
  const crNoun = provider === "gitlab" ? "merge" : "pull";

  const accounts = accountsQuery.data?.filter((a) => a.provider === provider) ?? [];
  const connected = accounts.length > 0;

  const openPopup = useCallback(() => {
    onError(null);
    onNote(null);
    const w = 640,
      h = 760;
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
    const url = `/api/v1/auth/oauth/${provider}/start?popup=1&next=${encodeURIComponent(`/p/${slug}/github`)}`;
    const popup = window.open(
      url,
      `dda_${provider}_oauth`,
      `width=${w},height=${h},left=${left},top=${top}`,
    );
    if (!popup) {
      window.location.href = url.replace("&popup=1", "").replace("?popup=1&", "?");
      return;
    }
    const timer = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(timer);
        qc.invalidateQueries({ queryKey: OAUTH_ACCOUNTS_KEY });
      }
    }, 800);
  }, [slug, provider, qc, onError, onNote]);

  async function onDisconnect(id: string) {
    onError(null);
    onNote(null);
    try {
      await disconnect.mutateAsync(id);
      onNote(`${label} account disconnected.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : `Could not disconnect the ${label} account.`);
    }
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title
          sub={`Used for repo access, Dockerfile/workflow ${crNoun} requests and CI setup`}
        >
          {label}
        </Block.Title>
      </Block.Header>

      {accountsQuery.isLoading ? (
        <Block.Loading />
      ) : !connected ? (
        <Block.Empty
          icon={provider}
          title={`No ${label} account connected`}
          description={`Connect ${label} so the agent can read this project's repositories and open ${crNoun} requests.`}
          action={
            <Btn variant="primary" icon={provider} onClick={openPopup}>
              Connect {label}
            </Btn>
          }
        />
      ) : (
        <Block.Body>
          <div className="col gap-3">
            {accounts.map((acc) => (
              <div key={acc.id} className="row between gap-3 wrap" style={{ alignItems: "center" }}>
                <div className="row gap-3" style={{ alignItems: "center", minWidth: 0 }}>
                  <Avatar name={acc.login ?? label} src={acc.avatarUrl} size={40} />
                  <div className="col" style={{ gap: 3, minWidth: 0 }}>
                    <div className="row gap-2" style={{ alignItems: "center" }}>
                      <strong style={{ fontSize: 14 }}>{acc.login ?? `${label} account`}</strong>
                      <Badge tone={acc.hasToken ? "ok" : "warn"} icon={provider}>
                        {acc.hasToken ? "Connected" : "Token missing"}
                      </Badge>
                    </div>
                    <span className="faint" style={{ fontSize: 12 }}>
                      {scopeSummary(provider, acc.scope)}
                    </span>
                  </div>
                </div>

                <div className="row gap-2">
                  <Btn variant="outline" size="sm" icon="refresh" onClick={openPopup}>
                    Reconnect
                  </Btn>
                  <Btn
                    variant="danger"
                    size="sm"
                    icon="trash"
                    loading={disconnect.isPending}
                    onClick={() => onDisconnect(acc.id)}
                  >
                    Disconnect
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        </Block.Body>
      )}
    </Block>
  );
}

/** Human summary of the granted OAuth scopes, per provider. */
function scopeSummary(provider: Provider, scope: string | null): string {
  if (!scope) return "No scopes recorded";
  const scopes = scope.split(/[\s,]+/).filter(Boolean);
  if (provider === "gitlab") {
    if (scopes.includes("api")) return "Full API access (repos, CI, variables)";
    return scopes.join(", ");
  }
  if (scopes.includes("repo")) return "Full repo access (private + public)";
  if (scopes.includes("public_repo")) return "Public repositories only";
  return scopes.join(", ");
}
