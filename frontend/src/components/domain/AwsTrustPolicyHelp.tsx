"use client";

import { useState } from "react";
import { Badge, Field } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import { useAwsExternalId } from "@/hooks/queries/connectivity";

/**
 * Read-only "set up your IAM role" helper for the AWS cross-account flow.
 *
 * Shows the platform-owned ExternalId and a ready-to-paste IAM trust policy
 * (both copyable). The user pastes the policy into a role in their own AWS
 * account, then hands back only the role ARN. The ExternalId is NEVER an input
 * — it's dictated by the platform to prevent the confused-deputy problem.
 */
export function AwsTrustPolicyHelp({ enabled = true }: { enabled?: boolean }) {
  const { data, isLoading, error } = useAwsExternalId(enabled);
  const [copied, setCopied] = useState<"eid" | "tp" | null>(null);

  async function copy(text: string, which: "eid" | "tp") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  if (isLoading) {
    return <span className="muted" style={{ fontSize: 12.5 }}>Loading your External ID…</span>;
  }
  if (error || !data?.ok) {
    return (
      <span style={{ fontSize: 12.5, color: "var(--danger)" }}>
        Couldn&apos;t load your External ID. {error instanceof Error ? error.message : ""}
      </span>
    );
  }

  const externalId = data.externalId;
  const trustPolicy = JSON.stringify(data.trustPolicy, null, 2);

  return (
    <div className="col gap-4">
      <div
        className="row gap-2"
        style={{
          padding: 12,
          background: "var(--info-soft)",
          borderRadius: 10,
          color: "var(--info)",
          fontSize: 12.5,
        }}
      >
        <Icon name="shield" size={16} style={{ flex: "none" }} />
        <span>
          Create an IAM role in your AWS account with the trust policy below, then paste its ARN.
          No access keys are stored — Deep Agent assumes the role via STS using the ExternalId we generate for you.
        </span>
      </div>

      {/* Your ExternalId (read-only) */}
      <Field
        label="Your External ID"
        hint="App-generated and the same for every AWS account you connect. Used in the trust policy below."
      >
        <CopyRow value={externalId} onCopy={() => copy(externalId, "eid")} copied={copied === "eid"} />
      </Field>

      {/* Platform account id status */}
      {!data.accountConfigured && (
        <div style={{ fontSize: 12, color: "var(--warn, #b8860b)" }}>
          <Badge tone="warn">Platform account not configured</Badge>{" "}
          The trust policy below shows a placeholder account. Set <span className="mono">PLATFORM_AWS_ACCOUNT_ID</span>{" "}
          on the server so the policy names a real principal.
        </div>
      )}

      {/* Trust policy JSON (read-only) */}
      <Field
        label="IAM trust policy"
        hint="AWS Console → IAM → Roles → your role → Trust relationships → Edit → paste this."
      >
        <div style={{ position: "relative" }}>
          <button
            type="button"
            className="btn outline sm"
            style={{ position: "absolute", top: 8, right: 8, zIndex: 1 }}
            onClick={() => copy(trustPolicy, "tp")}
          >
            <Icon name={copied === "tp" ? "check" : "copy"} size={13} />
            {copied === "tp" ? "Copied" : "Copy"}
          </button>
          <pre
            className="mono"
            style={{
              margin: 0,
              padding: 12,
              paddingTop: 40,
              fontSize: 11.5,
              lineHeight: 1.5,
              background: "var(--surface-2, #0000000a)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              overflowX: "auto",
              maxHeight: 240,
            }}
          >
            {trustPolicy}
          </pre>
        </div>
      </Field>
    </div>
  );
}

function CopyRow({ value, onCopy, copied }: { value: string; onCopy: () => void; copied: boolean }) {
  return (
    <div
      className="row gap-2"
      style={{
        alignItems: "center",
        padding: "8px 10px",
        background: "var(--surface-2, #0000000a)",
        border: "1px solid var(--border)",
        borderRadius: 8,
      }}
    >
      <span className="mono" style={{ flex: 1, wordBreak: "break-all", fontSize: 12.5 }}>
        {value}
      </span>
      <button type="button" className="btn outline sm" onClick={onCopy}>
        <Icon name={copied ? "check" : "copy"} size={13} />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
