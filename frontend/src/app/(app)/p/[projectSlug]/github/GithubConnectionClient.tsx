"use client";

/**
 * GitHub connection — project-workspace section to manage the GitHub account
 * the agent uses to read repos and open PRs. Lists the connected GitHub
 * identity with Disconnect + Reconnect actions. Reconnect reuses the exact
 * OAuth popup flow from CreateProjectWizard (start route with `popup=1`, the
 * callback closes it and postMessages back), so connecting here behaves the
 * same as connecting while creating a project.
 */
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Avatar, Badge, Block, Btn, PageHead } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import {
  useConnectedOAuthAccounts,
  useDisconnectOAuthAccount,
  type ConnectedOAuthAccount,
} from "@/hooks/queries/account";

const OAUTH_ACCOUNTS_KEY = ["account", "oauth-accounts"];

export function GithubConnectionClient({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const accountsQuery = useConnectedOAuthAccounts();
  const disconnect = useDisconnectOAuthAccount();

  const githubAccounts: ConnectedOAuthAccount[] =
    accountsQuery.data?.filter((a) => a.provider === "github") ?? [];
  const connected = githubAccounts.length > 0;

  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Open GitHub OAuth in a POPUP so the workspace never navigates away. Mirrors
  // CreateProjectWizard.openGithubPopup; on success the callback closes the
  // popup and postMessages back here (handled below).
  const openGithubPopup = useCallback(() => {
    setError(null);
    setNote(null);
    const w = 640, h = 760;
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
    const url = `/api/v1/auth/oauth/github/start?popup=1&next=${encodeURIComponent(
      `/p/${slug}/github`,
    )}`;
    const popup = window.open(url, "dda_github_oauth", `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) {
      // Popup blocked — fall back to a full-page redirect to the same flow.
      window.location.href = url.replace("&popup=1", "").replace("?popup=1&", "?");
      return;
    }
    // Safety net: refetch once the popup closes even if postMessage is blocked.
    const timer = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(timer);
        qc.invalidateQueries({ queryKey: OAUTH_ACCOUNTS_KEY });
      }
    }, 800);
  }, [slug, qc]);

  // Receive the popup's result and refresh the connected accounts in place.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { source?: string; status?: string } | null;
      if (!data || data.source !== "dda-oauth") return;
      if (data.status === "connected") {
        qc.invalidateQueries({ queryKey: OAUTH_ACCOUNTS_KEY });
        setNote("GitHub connected.");
        setError(null);
      } else if (data.status === "needs_login") {
        setError("Please sign in to the app first, then connect GitHub.");
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [qc]);

  async function onDisconnect(id: string) {
    setError(null);
    setNote(null);
    try {
      await disconnect.mutateAsync(id);
      setNote("GitHub account disconnected.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect the GitHub account.");
    }
  }

  return (
    <div className="col gap-4">
      <PageHead
        title="GitHub connection"
        sub="Manage the GitHub account the agent uses to read your repositories and open pull requests."
        actions={
          <Btn variant={connected ? "outline" : "primary"} icon="github" onClick={openGithubPopup}>
            {connected ? "Reconnect" : "Connect GitHub"}
          </Btn>
        }
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

      <Block>
        <Block.Header>
          <Block.Title sub="Used for repo access, Dockerfile/workflow PRs and CI setup">
            Connected account
          </Block.Title>
        </Block.Header>

        {accountsQuery.isLoading ? (
          <Block.Loading />
        ) : accountsQuery.isError ? (
          <Block.Error
            message={(accountsQuery.error as { message?: string })?.message ?? "Could not load accounts."}
            onRetry={() => accountsQuery.refetch()}
          />
        ) : !connected ? (
          <Block.Empty
            icon="github"
            title="No GitHub account connected"
            description="Connect GitHub so the agent can read this project's repositories and open pull requests."
            action={
              <Btn variant="primary" icon="github" onClick={openGithubPopup}>
                Connect GitHub
              </Btn>
            }
          />
        ) : (
          <Block.Body>
            <div className="col gap-3">
              {githubAccounts.map((acc) => (
                <div
                  key={acc.id}
                  className="row between gap-3 wrap"
                  style={{ alignItems: "center" }}
                >
                  <div className="row gap-3" style={{ alignItems: "center", minWidth: 0 }}>
                    <Avatar name={acc.login ?? "GitHub"} src={acc.avatarUrl} size={40} />
                    <div className="col" style={{ gap: 3, minWidth: 0 }}>
                      <div className="row gap-2" style={{ alignItems: "center" }}>
                        <strong style={{ fontSize: 14 }}>{acc.login ?? "GitHub account"}</strong>
                        <Badge tone={acc.hasToken ? "ok" : "warn"} icon="github">
                          {acc.hasToken ? "Connected" : "Token missing"}
                        </Badge>
                      </div>
                      <span className="faint" style={{ fontSize: 12 }}>
                        {scopeSummary(acc.scope)}
                      </span>
                    </div>
                  </div>

                  <div className="row gap-2">
                    <Btn variant="outline" size="sm" icon="refresh" onClick={openGithubPopup}>
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

      <p className="faint row gap-2" style={{ fontSize: 12, alignItems: "flex-start" }}>
        <Icon name="lock" />
        <span>
          Disconnecting removes the agent&apos;s access to your GitHub repositories. You can reconnect
          at any time — it&apos;s the same flow used when creating a project. If GitHub is your only
          sign-in method, set a password first or it can&apos;t be disconnected.
        </span>
      </p>
    </div>
  );
}

/** Human summary of the granted OAuth scopes. */
function scopeSummary(scope: string | null): string {
  if (!scope) return "No scopes recorded";
  const scopes = scope.split(/[\s,]+/).filter(Boolean);
  if (scopes.includes("repo")) return "Full repo access (private + public)";
  if (scopes.includes("public_repo")) return "Public repositories only";
  return scopes.join(", ");
}
