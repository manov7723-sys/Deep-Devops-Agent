"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Btn } from "@/components/ui";

export interface InviteAcceptClientProps {
  token: string;
  projectName: string;
  projectSlug: string;
  role: string;
  expiresAt: string;
}

/**
 * Renders the "Accept invitation" button. POSTs to
 * `/api/v1/invitations/[token]/accept`; on success redirects to the project
 * dashboard. The server already verified that the active session matches the
 * invited email — but the accept endpoint re-checks.
 */
export function InviteAcceptClient({
  token,
  projectName,
  projectSlug,
  role,
  expiresAt,
}: InviteAcceptClientProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        code?: string;
        redirect?: string;
      };
      if (!res.ok || !data.ok) {
        // already_member is recoverable — drop the user straight into the project.
        if (data.code === "already_member") {
          router.push(`/p/${projectSlug}/dashboard`);
          router.refresh();
          return;
        }
        setError(data.message ?? "Could not accept this invitation.");
        return;
      }
      router.push((data.redirect ?? `/p/${projectSlug}/dashboard`) as never);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept this invitation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col gap-3">
      <div
        className="col gap-1"
        style={{
          padding: "12px 14px",
          background: "var(--surface-2)",
          borderRadius: 10,
          border: "1px solid var(--border)",
          fontSize: 13,
        }}
      >
        <span>
          <span className="faint" style={{ fontSize: 11.5 }}>
            Project
          </span>
          <br />
          <b>{projectName}</b>
        </span>
        <span style={{ marginTop: 6 }}>
          <span className="faint" style={{ fontSize: 11.5 }}>
            Role
          </span>
          <br />
          <b style={{ textTransform: "capitalize" }}>{role}</b>
        </span>
        <span className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
          Link expires {new Date(expiresAt).toLocaleString()}
        </span>
      </div>

      <Btn variant="primary" icon="check" loading={busy} onClick={accept} block>
        Accept invitation
      </Btn>

      {error && (
        <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
