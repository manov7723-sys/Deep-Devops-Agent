"use client";

import { useSearchParams } from "next/navigation";
import type { Route } from "next";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Block, Btn, PageHead, TileGrid } from "@/components/ui";
import { EnvFilter, type EnvFilterValue } from "@/components/domain/EnvFilter";
import { CloudProviderCard } from "@/components/domain/CloudProviderCard";
import { ConnectCloudModal } from "@/components/modals/ConnectCloudModal";
import { VaultConfigSection } from "@/components/domain/VaultConfigSection";
import { AzureContextSection } from "@/components/domain/AzureContextSection";
import { GcpContextSection } from "@/components/domain/GcpContextSection";
import { api } from "@/lib/api/client";
import { useProjectProviders } from "@/hooks/queries/project";

// Superset row from /projects/[slug]/providers (real provider id, kind, and
// whether AWS access/secret keys are stored in Vault).
type AwsProviderItem = {
  providerId: string;
  kind: "aws" | "gcp" | "azure" | "proxmox";
  name: string;
  region: string;
  hasVaultCreds: boolean;
};

export function ProjectCloudClient({ slug }: { slug: string }) {
  const sp = useSearchParams();
  const env = (sp.get("env") as EnvFilterValue | null) ?? "all";
  const { data: providers } = useProjectProviders(slug, env);
  const [connectOpen, setConnectOpen] = useState(false);

  // Same endpoint the cards use, typed as the superset so we can read keys/Vault state.
  const { data: credRows } = useQuery<AwsProviderItem[]>({
    queryKey: ["p", slug, "providers", env, "creds"],
    queryFn: () => api.get<AwsProviderItem[]>(`/projects/${slug}/providers`, { env }),
    staleTime: 60_000,
  });
  const awsProviders = (credRows ?? []).filter((p) => p.kind === "aws");

  // The cloud this project targets — locks the Connect-provider modal to it.
  const { data: projectInfo } = useQuery<{ project: { cloud: string | null } }>({
    queryKey: ["p", slug, "project-cloud"],
    queryFn: () => api.get<{ project: { cloud: string | null } }>(`/projects/${slug}`),
    staleTime: 60_000,
  });
  const lockedKind = (projectInfo?.project?.cloud as "aws" | "gcp" | "azure" | "proxmox" | null) ?? null;

  return (
    <div className="col gap-5">
      <PageHead
        title="Cloud providers"
        sub="Connected accounts Deep Agent deploys to, per environment."
        actions={
          <Btn variant="primary" icon="plus" onClick={() => setConnectOpen(true)}>
            Connect provider
          </Btn>
        }
      />
      <EnvFilter />

      {providers ? (
        providers.length === 0 ? (
          <Block>
            <Block.Empty
              icon="cloud"
              title="No providers for this filter"
              description="Switch to a different environment or connect a new account."
            />
          </Block>
        ) : (
          <TileGrid minTile={320}>
            {providers.map((p) => (
              <CloudProviderCard
                key={p.id}
                provider={p}
                projectSlug={slug}
                statsHref={(`/p/${slug}/stats` + (env !== "all" ? `?env=${env}` : "")) as Route}
              />
            ))}
          </TileGrid>
        )
      ) : (
        <Block>
          <Block.Loading />
        </Block>
      )}

      {/* Azure context — subscription / resource group / region / environment.
          Self-hides on non-Azure projects. */}
      <AzureContextSection slug={slug} />
      <GcpContextSection slug={slug} />

      {/* Vault configuration — store AWS access key + secret in Vault; the
          agent reads them at runtime. Always shown so the Vault status + setup
          guidance are visible even before an AWS account is connected. */}
      <VaultConfigSection
        slug={slug}
        awsProviders={awsProviders.map((p) => ({
          providerId: p.providerId,
          name: p.name,
          region: p.region,
          hasVaultCreds: p.hasVaultCreds,
        }))}
      />

      <ConnectCloudModal
        open={connectOpen}
        onOpenChange={setConnectOpen}
        projectSlug={slug}
        lockedKind={lockedKind}
        initialKind={lockedKind ?? undefined}
      />
    </div>
  );
}
