"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, Btn, Icon, StatusDot } from "@/components/ui";
import { api } from "@/lib/api/client";
import type { SeedCloudProvider } from "@/lib/legacy-types";
import { EditCloudProviderModal } from "@/components/modals/EditCloudProviderModal";

const ENV_TONE = { prod: "ok", staging: "warn", dev: "info", release: "ok", beta: "warn", alpha: "info" } as const;

const PROVIDER_BG: Record<string, string> = {
  aws: "linear-gradient(135deg, #ff9900, #ec7211)",
  gcp: "linear-gradient(135deg, #4285f4, #34a853)",
  azure: "linear-gradient(135deg, #0078d4, #50e6ff)",
  proxmox: "linear-gradient(135deg, #e57000, #b34700)",
};

/** Pull a human message out of the api client's thrown ApiError ({ status,
 *  message, details }) — details holds the server's JSON body. */
function errMessage(e: unknown): string {
  const err = e as { message?: string; details?: unknown };
  const d = err?.details;
  if (d && typeof d === "object" && "message" in d) {
    const m = (d as { message?: unknown }).message;
    if (m) return String(m);
  }
  if (typeof d === "string") {
    try {
      const parsed = JSON.parse(d) as { message?: string };
      if (parsed.message) return parsed.message;
    } catch {
      /* not JSON */
    }
  }
  return err?.message || "Couldn't disconnect.";
}

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
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  // Only viewers without an underlying UUID can't edit (defensive — the
  // route always returns one, but we'd rather hide the gear than crash).
  const canEdit = !!provider.providerId;

  // Disconnect = delete the CloudProvider row (creds + Vault secret go with it).
  // The server returns 409 if an environment still points at it; `force=1` then
  // unlinks those envs (keeping each env's kubeconfig) and deletes.
  const disconnect = useMutation({
    mutationFn: (force: boolean) =>
      api.del(`/cloud-providers/${provider.providerId}${force ? "?force=1" : ""}`),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["cloud-providers"] });
      if (projectSlug) {
        qc.invalidateQueries({ queryKey: ["p", projectSlug, "providers"] });
        qc.invalidateQueries({ queryKey: ["p", projectSlug] });
      }
    },
  });

  async function onDisconnect() {
    if (!provider.providerId || disconnect.isPending) return;
    if (
      !window.confirm(
        `Disconnect ${provider.name}? Its stored credentials are removed. You can reconnect anytime.`,
      )
    )
      return;
    setError(null);
    try {
      await disconnect.mutateAsync(false);
    } catch (e) {
      // 409 = still linked to one or more environments → offer to unlink + delete.
      if ((e as { status?: number })?.status === 409) {
        if (
          window.confirm(
            "This provider is linked to one or more environments. Disconnect anyway and unlink them? Each environment keeps its stored kubeconfig.",
          )
        ) {
          try {
            await disconnect.mutateAsync(true);
          } catch (e2) {
            setError(errMessage(e2));
          }
        }
        return;
      }
      setError(errMessage(e));
    }
  }

  return (
    <div className="card card-pad col gap-3">
      <div className="row between">
        <div className="row gap-3" style={{ minWidth: 0 }}>
          <span
            className="row center dda-provider-tile"
            style={{ background: PROVIDER_BG[provider.id] }}
          >
            {provider.id.toUpperCase()}
          </span>
          <div className="col" style={{ lineHeight: 1.3, minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{provider.name}</span>
            <span className="faint mono" style={{ fontSize: 11.5 }}>
              {provider.account}
            </span>
          </div>
        </div>
        <StatusDot tone={provider.status} pulse={provider.status === "ok"} />
      </div>
      <div className="row gap-2 wrap">
        {(provider.envs as ReadonlyArray<keyof typeof ENV_TONE>).map((env) => (
          <Badge key={env} tone={ENV_TONE[env] ?? "default"}>
            {env}
          </Badge>
        ))}
      </div>
      <div className="divider" />
      <div className="row between" style={{ fontSize: 12.5 }}>
        <div className="col">
          <span className="faint">Region</span>
          <b className="mono" style={{ fontSize: 12 }}>
            {provider.region}
          </b>
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
        {canEdit && (
          <Btn
            size="sm"
            variant="ghost"
            icon="trash"
            aria-label={`Disconnect ${provider.name}`}
            title="Disconnect"
            loading={disconnect.isPending}
            onClick={onDisconnect}
          />
        )}
      </div>

      {error && <span style={{ color: "var(--danger, #e5484d)", fontSize: 12 }}>{error}</span>}

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
