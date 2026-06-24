"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { Badge, Btn, Icon, StatusDot } from "@/components/ui";
import type { SeedCloudProvider } from "@/lib/legacy-types";
import { EditCloudProviderModal } from "@/components/modals/EditCloudProviderModal";

const ENV_TONE = { release: "ok", beta: "warn", alpha: "info" } as const;

const PROVIDER_BG: Record<string, string> = {
  aws: "linear-gradient(135deg, #ff9900, #ec7211)",
  gcp: "linear-gradient(135deg, #4285f4, #34a853)",
  azure: "linear-gradient(135deg, #0078d4, #50e6ff)",
};

export interface CloudProviderCardProps {
  /**
   * Card row from `/projects/[slug]/providers`. The `id` is the *kind*
   * (aws/gcp/azure) used for visual styling; `providerId` carries the real
   * CloudProvider.id UUID needed for edits.
   */
  provider: SeedCloudProvider & { providerId?: string };
  /** Path the View stats button navigates to. */
  statsHref?: Route;
  /** Project slug for query-cache invalidation after edit/delete. */
  projectSlug?: string;
}

export function CloudProviderCard({ provider, statsHref, projectSlug }: CloudProviderCardProps) {
  const [editOpen, setEditOpen] = useState(false);
  // Only viewers without an underlying UUID can't edit (defensive — the
  // route always returns one, but we'd rather hide the gear than crash).
  const canEdit = !!provider.providerId;

  return (
    <div className="card card-pad col gap-3">
      <div className="row between">
        <div className="row gap-3" style={{ minWidth: 0 }}>
          <span className="row center dda-provider-tile" style={{ background: PROVIDER_BG[provider.id] }}>
            {provider.id.toUpperCase()}
          </span>
          <div className="col" style={{ lineHeight: 1.3, minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{provider.name}</span>
            <span className="faint mono" style={{ fontSize: 11.5 }}>{provider.account}</span>
          </div>
        </div>
        <StatusDot tone={provider.status} pulse={provider.status === "ok"} />
      </div>
      <div className="row gap-2 wrap">
        {(provider.envs as ReadonlyArray<keyof typeof ENV_TONE>).map((env) => (
          <Badge key={env} tone={ENV_TONE[env] ?? "default"}>{env}</Badge>
        ))}
      </div>
      <div className="divider" />
      <div className="row between" style={{ fontSize: 12.5 }}>
        <div className="col">
          <span className="faint">Region</span>
          <b className="mono" style={{ fontSize: 12 }}>{provider.region}</b>
        </div>
        <div className="col">
          <span className="faint">Services</span>
          <b>{provider.services}</b>
        </div>
        <div className="col" style={{ alignItems: "flex-end" }}>
          <span className="faint">Monthly</span>
          <b>{provider.spend}</b>
        </div>
      </div>
      <div className="row gap-2">
        {statsHref ? (
          <Link href={statsHref} className="btn outline sm grow">
            <Icon name="stats" size={14} />
            View stats
          </Link>
        ) : (
          <Btn size="sm" variant="outline" icon="stats" block>
            View stats
          </Btn>
        )}
        {canEdit && (
          <Btn
            size="sm"
            variant="ghost"
            icon="settings"
            aria-label={`Edit ${provider.name}`}
            onClick={() => setEditOpen(true)}
          />
        )}
      </div>

      {canEdit && (
        <EditCloudProviderModal
          open={editOpen}
          onOpenChange={setEditOpen}
          providerId={provider.providerId!}
          kind={provider.id}
          initial={{ name: provider.name, region: provider.region }}
          projectSlug={projectSlug}
        />
      )}
    </div>
  );
}
