"use client";

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Badge, Block, Btn, Icon, PageHead, Toggle } from "@/components/ui";
import {
  use2FA,
  useBackupCodes,
  useRegenerateBackupCodes,
  useToggle2FA,
} from "@/hooks/queries/account";

export function TwoFaManageClient() {
  const { data: state } = use2FA();
  const { data: codeStatus } = useBackupCodes();
  const toggle = useToggle2FA();
  const regen = useRegenerateBackupCodes();
  const enabled = state?.enabled ?? false;
  // Plaintext codes are returned ONCE by POST. We hold them in component
  // state for display until the user navigates away or regenerates again.
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);

  return (
    <div className="col gap-5" style={{ maxWidth: 680 }}>
      <PageHead
        title="Two-factor authentication"
        sub="Add a second layer of security to your account."
      />

      <Block>
        <Block.Body>
          <div className="row between gap-3 wrap">
            <div className="row gap-3" style={{ minWidth: 0 }}>
              <span
                className="row center"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 11,
                  background: enabled ? "var(--ok-soft)" : "var(--surface-2)",
                  color: enabled ? "var(--ok)" : "var(--text-muted)",
                  flex: "none",
                }}
              >
                <Icon name="shield" size={20} />
              </span>
              <div className="col" style={{ lineHeight: 1.4 }}>
                <span className="row gap-2" style={{ fontWeight: 700 }}>
                  Authenticator app
                  {enabled && <Badge tone="ok">Enabled</Badge>}
                </span>
                <span className="faint" style={{ fontSize: 12.5 }}>
                  Google Authenticator · added Jan 2025
                </span>
              </div>
            </div>
            <Toggle
              checked={enabled}
              onCheckedChange={(v) => toggle.mutate(v)}
              ariaLabel="Two-factor authentication"
            />
          </div>
        </Block.Body>
      </Block>

      {enabled && (
        <Block>
          <Block.Header>
            <Block.Title>Backup codes</Block.Title>
            <Block.Actions>
              <Btn
                size="sm"
                variant="outline"
                icon="refresh"
                loading={regen.isPending}
                onClick={async () => {
                  const codes = await regen.mutateAsync();
                  setFreshCodes(codes);
                }}
              >
                Regenerate
              </Btn>
            </Block.Actions>
          </Block.Header>
          <Block.Body>
            <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
              {codeStatus
                ? `${codeStatus.remaining} of ${codeStatus.total} codes remaining.`
                : "Loading…"}{" "}
              Each can be used once if you lose your device.
            </p>
            {freshCodes ? (
              <>
                <p
                  style={{
                    fontSize: 12.5,
                    color: "var(--warn)",
                    marginBottom: 8,
                  }}
                >
                  Copy these now — they won&apos;t be shown again.
                </p>
                <div className="dda-backup-codes">
                  {freshCodes.map((c) => (
                    <span key={c} className="dda-backup-code">
                      {c}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="faint" style={{ fontSize: 12 }}>
                Codes are only shown immediately after regeneration. Click <b>Regenerate</b> to
                issue a new set.
              </p>
            )}
          </Block.Body>
        </Block>
      )}

      <div className="row">
        <Link href={"/account/profile" as Route} className="btn ghost">
          ← Back to profile
        </Link>
      </div>
    </div>
  );
}
