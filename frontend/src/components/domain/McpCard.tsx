"use client";

import { Badge, Btn, Icon, StatusDot } from "@/components/ui";
import type { SeedMcpConnector } from "@/lib/legacy-types";

export type McpCardVariant = "compact" | "full";

export interface McpCardProps {
  connector: SeedMcpConnector;
  variant?: McpCardVariant;
  onConfigure?: (id: string) => void;
  onReconnect?: (id: string) => void;
  onLogs?: (id: string) => void;
}

function statusTone(s: SeedMcpConnector["status"]): "ok" | "warn" | "danger" {
  if (s === "down") return "danger";
  if (s === "warn") return "warn";
  return "ok";
}

function statusLabel(s: SeedMcpConnector["status"]): string {
  if (s === "down") return "Down";
  if (s === "warn") return "Degraded";
  return "Healthy";
}

/**
 * Variants:
 *   compact — single dense row used by /admin/dashboard. status dot + name + latency.
 *   full    — Phase 9 tile with Configure/Reconnect/Logs actions.
 */
export function McpCard({
  connector,
  variant = "full",
  onConfigure,
  onReconnect,
  onLogs,
}: McpCardProps) {
  if (variant === "compact") {
    return (
      <div className="row between gap-3 dda-mcp-row">
        <div className="row gap-3" style={{ minWidth: 0 }}>
          <Icon name="server" size={16} style={{ color: "var(--text-faint)" }} />
          <span style={{ fontWeight: 600, fontSize: 13 }}>{connector.name}</span>
        </div>
        <div className="row gap-3" style={{ flex: "none" }}>
          <span className="faint mono" style={{ fontSize: 11.5 }}>
            {connector.latency}
          </span>
          <StatusDot tone={statusTone(connector.status)} label={statusLabel(connector.status)} />
        </div>
      </div>
    );
  }
  const tone = statusTone(connector.status);
  return (
    <div className="card card-pad col gap-3">
      <div className="row between">
        <div className="row gap-3" style={{ minWidth: 0 }}>
          <span className="row center dda-mcp-tile">
            <Icon name="server" size={18} />
          </span>
          <div className="col" style={{ lineHeight: 1.3, minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{connector.name}</span>
            <span className="faint" style={{ fontSize: 11.5 }}>
              {connector.description}
            </span>
          </div>
        </div>
        <StatusDot
          tone={tone}
          pulse={connector.status === "ok"}
          label={statusLabel(connector.status)}
        />
      </div>
      <div className="divider" />
      <div className="row between" style={{ fontSize: 12.5 }}>
        <div className="col">
          <span className="faint">Calls</span>
          <b className="tnum">{connector.callsPerDay}</b>
        </div>
        <div className="col">
          <span className="faint">Latency</span>
          <b className="mono">{connector.latency}</b>
        </div>
        <div className="col" style={{ alignItems: "flex-end" }}>
          <span className="faint">State</span>
          <Badge tone={tone}>{statusLabel(connector.status)}</Badge>
        </div>
      </div>
      <div className="row gap-2">
        <Btn
          size="sm"
          variant="outline"
          block
          icon="settings"
          onClick={() => onConfigure?.(connector.id)}
        >
          Configure
        </Btn>
        {connector.status === "down" ? (
          <Btn
            size="sm"
            variant="primary"
            icon="refresh"
            onClick={() => onReconnect?.(connector.id)}
          >
            Reconnect
          </Btn>
        ) : (
          <Btn size="sm" variant="ghost" icon="eye" onClick={() => onLogs?.(connector.id)}>
            Logs
          </Btn>
        )}
      </div>
    </div>
  );
}
