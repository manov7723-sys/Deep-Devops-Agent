"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Block, Btn, PageHead } from "@/components/ui";
import {
  useJenkinsList,
  useJenkinsOutputs,
  type JenkinsServerItem,
} from "@/hooks/queries/network";

/**
 * Jenkins — sidebar-native list of every Jenkins VM this project provisioned.
 *
 * For each APPLIED row we fetch the terraform outputs live and render a
 * ready-to-copy SSH command that uses the ACTUAL key pair name (not AWS
 * Console's misleading `id_rsa` boilerplate), plus the Jenkins URL + admin
 * user, and a Reveal-on-click admin password.
 */
export function ProjectJenkinsClient({ slug }: { slug: string }) {
  const { data, isLoading, error } = useJenkinsList(slug);
  const items = data?.items ?? [];

  return (
    <div className="col gap-5">
      <PageHead
        title="Jenkins"
        sub="One-click Jenkins servers provisioned on EC2. Each row is a fully self-configured VM with an admin user + skipped setup wizard."
      />

      {isLoading && (
        <Block>
          <Block.Body>
            <span className="muted" style={{ fontSize: 13 }}>Loading Jenkins servers…</span>
          </Block.Body>
        </Block>
      )}

      {error && (
        <Block>
          <Block.Body>
            <p style={{ fontSize: 13, color: "var(--danger)" }}>
              Failed to load Jenkins list. {error instanceof Error ? error.message : "Unknown error."}
            </p>
          </Block.Body>
        </Block>
      )}

      {!isLoading && !error && items.length === 0 && (
        <Block>
          <Block.Body>
            <div className="col gap-2">
              <p style={{ fontSize: 13, fontWeight: 600 }}>No Jenkins servers yet.</p>
              <p className="muted" style={{ fontSize: 12.5 }}>
                Head to the chat and say <span className="mono">provision jenkins</span> to launch one.
                Takes ~5 min end-to-end.
              </p>
              <div>
                <Link href={`/p/${slug}/chat`}>
                  <Btn variant="primary" icon="chat">Open chat</Btn>
                </Link>
              </div>
            </div>
          </Block.Body>
        </Block>
      )}

      {items.map((item) => (
        <JenkinsRow key={item.approvalId} slug={slug} item={item} />
      ))}
    </div>
  );
}

function JenkinsRow({ slug, item }: { slug: string; item: JenkinsServerItem }) {
  const applied = item.status === "approved" && !!item.appliedAt;
  const [revealPassword, setRevealPassword] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Only fire the outputs fetch for applied stacks. Once the user clicks
  // Reveal, a second fetch (with includeSecret) runs alongside the first.
  const outputsQuery = useJenkinsOutputs(slug, applied ? item.approvalId : null, false);
  const secretQuery = useJenkinsOutputs(slug, revealPassword ? item.approvalId : null, true);

  const outputs = outputsQuery.data?.outputs;
  const password = secretQuery.data?.outputs?.jenkinsAdminPassword;
  const loadingOutputs = outputsQuery.isLoading;

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(label);
        setTimeout(() => setCopied(null), 1500);
      },
      () => setCopied(null),
    );
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub={item.title}>{item.name}</Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3">
          <div className="row gap-2 wrap" style={{ fontSize: 12.5 }}>
            <Badge tone={applied ? "ok" : item.status === "rejected" ? "danger" : "warn"}>
              {applied ? "applied" : item.status}
            </Badge>
            {item.envName && <Badge tone="info">{item.envName}</Badge>}
            <span className="muted">
              Created {new Date(item.requestedAt).toLocaleString()}
              {item.appliedAt ? ` · Applied ${new Date(item.appliedAt).toLocaleString()}` : ""}
            </span>
          </div>

          {!applied && (
            <div className="muted" style={{ fontSize: 12.5 }}>
              Approve + apply this stack in the Approvals page before it&apos;s reachable.
            </div>
          )}

          {applied && loadingOutputs && (
            <span className="muted" style={{ fontSize: 12.5 }}>Reading Terraform outputs…</span>
          )}

          {applied && outputsQuery.error && (
            <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
              Couldn&apos;t read outputs: {outputsQuery.error instanceof Error ? outputsQuery.error.message : "unknown error"}
            </p>
          )}

          {applied && outputs && (
            <div
              className="col gap-3"
              style={{ padding: 14, borderRadius: 8, background: "var(--surface-2)", fontSize: 13 }}
            >
              <InfoRow label="Jenkins URL">
                {outputs.jenkinsUrl ? (
                  <div className="row gap-2" style={{ alignItems: "center" }}>
                    <a href={outputs.jenkinsUrl} target="_blank" rel="noreferrer" className="mono" style={{ color: "var(--accent, #5b8cff)" }}>
                      {outputs.jenkinsUrl}
                    </a>
                    <Btn variant="ghost" onClick={() => copy(outputs.jenkinsUrl!, "url")}>
                      {copied === "url" ? "Copied!" : "Copy"}
                    </Btn>
                  </div>
                ) : "—"}
              </InfoRow>

              <InfoRow label="Admin user">
                <span className="mono">{outputs.jenkinsAdminUsername ?? "—"}</span>
              </InfoRow>

              <InfoRow label="Admin password">
                {password ? (
                  <div className="row gap-2" style={{ alignItems: "center" }}>
                    <span className="mono">{password}</span>
                    <Btn variant="ghost" onClick={() => copy(password, "pw")}>
                      {copied === "pw" ? "Copied!" : "Copy"}
                    </Btn>
                    <Btn variant="ghost" onClick={() => setRevealPassword(false)}>Hide</Btn>
                  </div>
                ) : (
                  <Btn
                    variant="ghost"
                    icon="eye"
                    loading={revealPassword && secretQuery.isLoading}
                    onClick={() => setRevealPassword(true)}
                  >
                    Reveal password
                  </Btn>
                )}
              </InfoRow>

              <InfoRow label="Instance ID">
                <span className="mono">{outputs.instanceId ?? "—"}</span>
              </InfoRow>

              <InfoRow label="SSH key pair attached">
                {outputs.keyName ? <span className="mono">{outputs.keyName}</span> : <span className="muted">none (SSM only)</span>}
              </InfoRow>

              <InfoRow label={outputs.keyName ? "Shell in" : "Shell in via SSM"}>
                {outputs.shellCommand ? (
                  <div className="col gap-1" style={{ width: "100%" }}>
                    <pre
                      className="mono"
                      style={{
                        margin: 0,
                        padding: 10,
                        background: "var(--surface-3, var(--surface))",
                        borderRadius: 6,
                        fontSize: 12.5,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                      }}
                    >{outputs.shellCommand}</pre>
                    <div className="row gap-2">
                      <Btn variant="ghost" onClick={() => copy(outputs.shellCommand!, "shell")}>
                        {copied === "shell" ? "Copied!" : "Copy command"}
                      </Btn>
                    </div>
                  </div>
                ) : "—"}
              </InfoRow>

              {outputs.keyName && (
                <div className="muted" style={{ fontSize: 11.5 }}>
                  Use the <span className="mono">{outputs.keyName}.pem</span> you downloaded when you created that key pair
                  in the AWS EC2 console. Ignore AWS Connect helper&apos;s <span className="mono">id_rsa</span> — that&apos;s
                  a generic filename hint, not the real key name.
                </div>
              )}
            </div>
          )}

          <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
            {applied && (
              <Btn
                variant="ghost"
                icon="refresh"
                loading={outputsQuery.isFetching}
                onClick={() => {
                  outputsQuery.refetch();
                  if (revealPassword) secretQuery.refetch();
                }}
              >
                Refresh
              </Btn>
            )}
            <Link href={`/p/${slug}/approvals`}>
              <Btn variant="ghost">Open approval</Btn>
            </Link>
          </div>
        </div>
      </Block.Body>
    </Block>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
      <span className="muted" style={{ minWidth: 160, fontSize: 12.5 }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
