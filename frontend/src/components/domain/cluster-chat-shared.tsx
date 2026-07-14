"use client";

/**
 * Shared presentation + helpers for the deterministic cluster-creation "chat
 * boxes" (EKS / GKE / AKS). Each cloud has its own form fields, but the chat
 * transcript bubbles, the Jenkins-style Terraform stage view, and the API error
 * formatting are identical — so they live here and are imported by all three.
 */
import { useState } from "react";
import { Badge, Block } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import type { TfRun, TfStageStatus } from "@/hooks/queries/connectivity";

export type Bubble =
  { id: string; role: "assistant"; text: string } | { id: string; role: "user"; text: string };

export const STAGE_SYMBOL: Record<TfStageStatus, string> = {
  pending: "○",
  running: "◐",
  succeeded: "✓",
  failed: "✕",
  skipped: "–",
};

export function ChatBubble({
  role,
  children,
}: {
  role: "assistant" | "user";
  children: React.ReactNode;
}) {
  const isAssistant = role === "assistant";
  return (
    <div
      className="row gap-2"
      style={{ alignItems: "flex-start", flexDirection: isAssistant ? "row" : "row-reverse" }}
    >
      <span
        className="row center"
        style={{
          width: 26,
          height: 26,
          flex: "none",
          borderRadius: 8,
          background: "var(--surface-3, #00000010)",
        }}
      >
        <Icon name={isAssistant ? "bot" : "user"} size={14} />
      </span>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          padding: "8px 12px",
          borderRadius: 10,
          maxWidth: 520,
          whiteSpace: "pre-wrap",
          background: isAssistant
            ? "var(--surface-2, #00000008)"
            : "var(--accent-soft, var(--accent, #5b8cff)22)",
          border: "1px solid var(--border, #00000014)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function TerraformStageView({ run }: { run: TfRun }) {
  const [open, setOpen] = useState<string | null>(null);
  const tone = run.status === "succeeded" ? "ok" : run.status === "failed" ? "danger" : "info";
  return (
    <Block>
      <Block.Header>
        <Block.Title sub={`${run.action} · ${run.envKey}`}>
          <span className="row gap-2" style={{ alignItems: "center" }}>
            {run.name}
            <Badge tone={tone} withDot>
              {run.status}
            </Badge>
          </span>
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-1">
          {run.stages.map((s) => (
            <div key={s.name} className="col">
              <button
                type="button"
                className="row gap-2"
                style={{
                  alignItems: "center",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "4px 0",
                  textAlign: "left",
                  width: "100%",
                }}
                onClick={() => setOpen((o) => (o === s.name ? null : s.name))}
              >
                <span style={{ width: 16, textAlign: "center", color: stageColor(s.status) }}>
                  {STAGE_SYMBOL[s.status]}
                </span>
                <span className="mono" style={{ fontSize: 12.5 }}>
                  terraform {s.name}
                </span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {s.status === "succeeded"
                    ? `${s.name} succeeded`
                    : s.status === "running"
                      ? `${s.name} running…`
                      : s.status === "failed"
                        ? `${s.name} failed`
                        : s.status === "skipped"
                          ? "skipped"
                          : "pending"}
                  {typeof s.exitCode === "number" ? ` · exit ${s.exitCode}` : ""}
                </span>
              </button>
              {open === s.name && s.logs.trim() && (
                <pre
                  style={{
                    fontSize: 11.5,
                    overflowX: "auto",
                    whiteSpace: "pre-wrap",
                    margin: "2px 0 6px 16px",
                    maxHeight: 240,
                    background: "var(--surface-2, #0000000a)",
                    padding: 8,
                    borderRadius: 6,
                  }}
                >
                  {s.logs.slice(-3000)}
                </pre>
              )}
            </div>
          ))}
          {run.error && (
            <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>{run.error}</span>
          )}
        </div>
      </Block.Body>
    </Block>
  );
}

export function stageColor(status: TfStageStatus): string {
  if (status === "succeeded") return "var(--ok, #30a46c)";
  if (status === "failed") return "var(--danger, #e5484d)";
  if (status === "running") return "var(--accent, #5b8cff)";
  return "var(--muted, #888)";
}

/** Pull the server's human message out of the api client's ApiError (which puts
 *  the raw JSON body in `details`), falling back to the HTTP status text. */
export function apiErrorMessage(e: unknown): string {
  if (e && typeof e === "object" && "details" in e) {
    const details = (e as { details?: unknown }).details;
    if (typeof details === "string") {
      try {
        const parsed = JSON.parse(details) as { message?: string };
        if (parsed.message) return parsed.message;
      } catch {
        /* not JSON — fall through */
      }
    }
  }
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message?: unknown }).message ?? "Request failed.");
  }
  return e instanceof Error ? e.message : "Request failed.";
}
