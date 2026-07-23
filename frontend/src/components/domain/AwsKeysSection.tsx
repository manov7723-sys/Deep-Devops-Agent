"use client";

import { useState } from "react";
import { Badge, Block, Btn } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import { CloudCredentialsModal } from "@/components/modals/CloudCredentialsModal";

export type AwsKeysProvider = {
  providerId: string;
  name: string;
  region: string;
  hasAwsKeysStored: boolean;
};

/**
 * Optional AWS access key + secret storage, per connected AWS account.
 * Encrypted directly on the CloudProvider row (AES-256-GCM, same tier as
 * Azure's stored Service-Principal secret) — no external service to connect
 * first. Most projects never need this: STS AssumeRole (set up when the
 * account was connected) is the default, secretless path.
 */
export function AwsKeysSection({
  slug,
  awsProviders,
}: {
  slug: string;
  awsProviders: AwsKeysProvider[];
}) {
  const [credFor, setCredFor] = useState<{ id: string; name: string } | null>(null);

  if (awsProviders.length === 0) return null;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Optional — only needed if you want to use a long-lived access key instead of the default AssumeRole connection. Encrypted at rest; no external service required.">
          <span className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="lock" size={16} /> AWS access keys
          </span>
        </Block.Title>
      </Block.Header>

      <div className="col gap-2">
        {awsProviders.map((p) => (
          <div
            key={p.providerId}
            className="row gap-3"
            style={{ alignItems: "center", justifyContent: "space-between" }}
          >
            <div className="row gap-2" style={{ alignItems: "center" }}>
              <span style={{ fontWeight: 600 }}>{p.name}</span>
              <span className="text-sm muted">{p.region}</span>
              {p.hasAwsKeysStored ? (
                <Badge tone="ok" withDot>
                  keys stored
                </Badge>
              ) : (
                <Badge tone="default" withDot>
                  using AssumeRole
                </Badge>
              )}
            </div>
            <Btn
              variant="outline"
              size="sm"
              icon="lock"
              onClick={() => setCredFor({ id: p.providerId, name: p.name })}
            >
              {p.hasAwsKeysStored ? "Update keys" : "Add keys"}
            </Btn>
          </div>
        ))}
      </div>

      <CloudCredentialsModal
        open={!!credFor}
        onOpenChange={(o) => !o && setCredFor(null)}
        providerId={credFor?.id ?? null}
        providerName={credFor?.name ?? ""}
        slug={slug}
      />
    </Block>
  );
}
