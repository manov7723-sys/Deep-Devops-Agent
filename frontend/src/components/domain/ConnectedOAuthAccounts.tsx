"use client";

import { useState } from "react";
import { Block, Btn, Icon } from "@/components/ui";
import {
  useConnectedOAuthAccounts,
  useDisconnectOAuthAccount,
  type ConnectedOAuthAccount,
} from "@/hooks/queries/account";

const PROVIDER_LABEL: Record<ConnectedOAuthAccount["provider"], string> = {
  github: "GitHub",
  google: "Google",
  gitlab: "GitLab",
};

const PROVIDER_ICON: Record<ConnectedOAuthAccount["provider"], "github" | "user" | "gitlab"> = {
  github: "github",
  google: "user",
  gitlab: "gitlab",
};

/**
 * "Connected GitHub / Google accounts" block. Renders the list and lets the
 * user connect *another* account (e.g. a second GitHub identity for work
 * repos vs personal repos) or disconnect any existing one.
 *
 * "Connect another" launches the standard OAuth start endpoint with
 * `?next=/account/profile` so the callback brings them back here.
 */
export function ConnectedOAuthAccounts() {
  const { data: accounts, isLoading } = useConnectedOAuthAccounts();
  const disconnect = useDisconnectOAuthAccount();
  const [error, setError] = useState<string | null>(null);

  const connectAnother = (provider: "github" | "google") => {
    setError(null);
    const next = encodeURIComponent("/account/profile");
    // Browser navigates so OAuth's cookie/state machinery works the same way
    // it does for the login button.
    window.location.href = `/api/v1/auth/oauth/${provider}/start?next=${next}`;
  };

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Each row is one identity at the provider. Connect more than one to run different projects against different GitHub accounts.">
          Connected accounts
        </Block.Title>
        <Block.Actions>
          <Btn size="sm" variant="outline" icon="github" onClick={() => connectAnother("github")}>
            Connect GitHub
          </Btn>
        </Block.Actions>
      </Block.Header>
      <Block.Body>
        {isLoading || !accounts ? (
          <Block.Loading />
        ) : accounts.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            No accounts connected yet. Click <b>Connect GitHub</b> above.
          </span>
        ) : (
          <div className="col">
            {accounts.map((a) => (
              <OAuthAccountRow
                key={a.id}
                account={a}
                onDisconnect={async () => {
                  setError(null);
                  if (
                    !confirm(
                      `Disconnect ${PROVIDER_LABEL[a.provider]} account "${a.login ?? a.providerAccountId}"? Projects wired to this account will need to be re-wired.`,
                    )
                  )
                    return;
                  try {
                    await disconnect.mutateAsync(a.id);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Could not disconnect account.");
                  }
                }}
                busy={disconnect.isPending}
              />
            ))}
          </div>
        )}
        {error && (
          <p style={{ marginTop: 10, fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {error}
          </p>
        )}
      </Block.Body>
    </Block>
  );
}

function OAuthAccountRow({
  account,
  onDisconnect,
  busy,
}: {
  account: ConnectedOAuthAccount;
  onDisconnect: () => Promise<void>;
  busy: boolean;
}) {
  const label = account.login ?? `id:${account.providerAccountId.slice(0, 8)}`;
  return (
    <div
      className="row between gap-3"
      style={{ padding: "14px 0", borderBottom: "1px solid var(--border-soft)" }}
    >
      <div className="row gap-3" style={{ minWidth: 0 }}>
        {account.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={account.avatarUrl}
            alt=""
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              objectFit: "cover",
              flex: "none",
            }}
          />
        ) : (
          <span
            className="row center"
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: "var(--surface-2)",
              color: "var(--text)",
              flex: "none",
            }}
          >
            <Icon name={PROVIDER_ICON[account.provider]} size={18} />
          </span>
        )}
        <div className="col" style={{ lineHeight: 1.35, minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>
            {PROVIDER_LABEL[account.provider]} · <span className="mono">{label}</span>
          </span>
          <span className="faint" style={{ fontSize: 12 }}>
            Connected {new Date(account.createdAt).toLocaleDateString()}
            {account.scope ? ` · scopes ${account.scope}` : ""}
            {!account.hasToken ? " · token missing" : ""}
          </span>
        </div>
      </div>
      <Btn size="sm" variant="outline" icon="x" loading={busy} onClick={onDisconnect}>
        Disconnect
      </Btn>
    </div>
  );
}
