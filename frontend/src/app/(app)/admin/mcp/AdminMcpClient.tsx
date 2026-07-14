"use client";

import { useState } from "react";
import { Block, Btn, Empty, Icon, PageHead, TileGrid } from "@/components/ui";
import { McpCard } from "@/components/domain/McpCard";
import { useAdminMcpAction, useAdminMcpList } from "@/hooks/queries/admin-ops";
import { AddMcpServerModal } from "@/components/modals/AddMcpServerModal";
import { ConfigureMcpModal } from "@/components/modals/ConfigureMcpModal";

type Preset = "kubernetes" | "terraform" | null;

type McpConnectorRow = {
  id: string;
  name: string;
  description: string;
  status: string;
  callsPerDay: string;
  latency: string;
};

export function AdminMcpClient() {
  const { data: connectors, isError, error, refetch, isLoading } = useAdminMcpList();
  const action = useAdminMcpAction();
  const [addOpen, setAddOpen] = useState<{ open: boolean; preset: Preset }>({
    open: false,
    preset: null,
  });
  const [configureTarget, setConfigureTarget] = useState<McpConnectorRow | null>(null);

  const openWith = (preset: Preset) => setAddOpen({ open: true, preset });

  return (
    <div className="col gap-5">
      <PageHead
        title="MCP servers"
        sub="Model Context Protocol integrations agents use to act on infrastructure."
        actions={
          <Btn variant="primary" icon="plus" onClick={() => openWith(null)}>
            Connect server
          </Btn>
        }
      />
      <Block>
        {isError ? (
          <Block.Error
            message={
              (error as { message?: string } | undefined)?.message ?? "Could not load MCP servers."
            }
            onRetry={() => refetch()}
          />
        ) : isLoading || !connectors ? (
          <Block.Loading />
        ) : connectors.length === 0 ? (
          <div className="card-pad col gap-4">
            <Empty
              icon="server"
              title="No MCP servers yet"
              description="Connect a server so your agents can read state and run actions on it. Pick a preset to get started fast."
            />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
              }}
            >
              <PresetCard
                icon="layers"
                title="Kubernetes"
                body="kubectl + cluster-state for pods, deployments, manifests."
                onClick={() => openWith("kubernetes")}
              />
              <PresetCard
                icon="cloud"
                title="Terraform"
                body="terraform plan/apply over a workspace; IaC changes via agents."
                onClick={() => openWith("terraform")}
              />
              <PresetCard
                icon="plus"
                title="Custom MCP"
                body="Wire any MCP-compatible server with your own auth method."
                onClick={() => openWith(null)}
              />
            </div>
          </div>
        ) : (
          <div className="card-pad">
            <TileGrid minTile={320}>
              {connectors.map((m) => (
                <McpCard
                  key={m.id}
                  connector={m}
                  variant="full"
                  onReconnect={(id) => action.mutate({ id, action: "reconnect" })}
                  onConfigure={() => setConfigureTarget(m as unknown as McpConnectorRow)}
                  onLogs={(id) => action.mutate({ id, action: "logs" })}
                />
              ))}
            </TileGrid>
          </div>
        )}
      </Block>

      <AddMcpServerModal
        open={addOpen.open}
        onOpenChange={(open) => setAddOpen((s) => ({ ...s, open }))}
        preset={addOpen.preset}
      />

      {configureTarget && (
        <ConfigureMcpModal
          open={!!configureTarget}
          onOpenChange={(o) => {
            if (!o) setConfigureTarget(null);
          }}
          connector={configureTarget}
        />
      )}
    </div>
  );
}

function PresetCard({
  icon,
  title,
  body,
  onClick,
}: {
  icon: "layers" | "cloud" | "plus";
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card card-pad col gap-2"
      style={{ textAlign: "left", cursor: "pointer", borderColor: "var(--border)" }}
    >
      <span className="row gap-2" style={{ alignItems: "center" }}>
        <span
          className="row center"
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: "var(--accent-soft)",
            color: "var(--accent)",
            flex: "none",
          }}
        >
          <Icon name={icon} size={15} />
        </span>
        <span style={{ fontWeight: 700 }}>{title}</span>
      </span>
      <span className="muted" style={{ fontSize: 12.5, lineHeight: 1.4 }}>
        {body}
      </span>
    </button>
  );
}
