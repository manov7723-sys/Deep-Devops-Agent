"use client";

import { useEffect, useRef } from "react";
import { Badge, Btn, Icon, StatusDot } from "@/components/ui";
import { ChatMsg } from "@/components/domain/ChatMsg";
import { ChatComposer } from "@/components/domain/ChatComposer";
import { useChatSuggestions, useChatThread, useClearChat } from "@/hooks/queries/project";
import { useSendChatMessageStream, type ToolCallView } from "@/hooks/queries/chat-stream";

export interface ProjectChatClientProps {
  slug: string;
}

export function ProjectChatClient({ slug }: ProjectChatClientProps) {
  const { data: thread } = useChatThread(slug);
  const { data: suggestions } = useChatSuggestions(slug);
  const { send, status } = useSendChatMessageStream(slug);
  const clearChat = useClearChat(slug);

  const isThinking = status.state === "sending";
  const isStreaming = status.state === "streaming";
  const partial = isStreaming ? status.partial : "";
  const agentError = status.state === "error" ? status.message : null;
  const toolCalls =
    status.state === "streaming" || status.state === "sending" || status.state === "error"
      ? status.toolCalls
      : [];

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [thread, partial, isThinking]);

  const messages = thread ?? [];

  function handleSend(text: string) {
    send(text).catch(() => {});
  }

  return (
    <div className="dda-chat-page">
      <header className="dda-chat-head">
        <div className="row gap-3">
          <span className="dda-chat-head-icon">
            <Icon name="bot" size={18} />
          </span>
          <div className="col" style={{ lineHeight: 1.3 }}>
            <span className="row gap-2" style={{ fontWeight: 700, fontSize: 14 }}>
              Deep Agent <StatusDot tone="ok" pulse />
            </span>
            <span className="faint" style={{ fontSize: 11.5 }}>
              Claude Sonnet 4.5 · sees all repos &amp; cloud state
            </span>
          </div>
        </div>
        <div className="row gap-2">
          <Badge icon="layers">{slug}</Badge>
          <Btn
            size="sm"
            variant="outline"
            icon="trash"
            loading={clearChat.isPending}
            disabled={clearChat.isPending || isThinking || isStreaming || messages.length === 0}
            onClick={() => clearChat.mutate()}
          >
            Clear
          </Btn>
          <Btn
            size="sm"
            variant="outline"
            icon="plus"
            disabled={clearChat.isPending || isThinking || isStreaming}
            onClick={() => clearChat.mutate()}
          >
            New chat
          </Btn>
        </div>
      </header>

      <div ref={scrollRef} className="dda-chat-scroll">
        <div className="dda-chat-inner">
          {messages.map((m, i) => (
            <ChatMsg
              key={m.id}
              message={m}
              slug={slug}
              interactive={i === messages.length - 1 && m.role === "agent" && !isThinking && !isStreaming}
              onOption={handleSend}
            />
          ))}
          {toolCalls.length > 0 && (
            <div className="col gap-1" style={{ padding: "6px 0 0 44px" }}>
              {toolCalls.map((t) => (
                <ToolCallChip key={t.toolUseId} call={t} />
              ))}
            </div>
          )}
          {isStreaming && partial && (
            <div className="dda-chat-streaming-wrap">
              <ChatMsg
                message={{ id: "streaming", role: "agent", text: partial }}
                slug={slug}
              />
              <span className="dda-chat-streaming-cursor" aria-hidden>
                ▍
              </span>
            </div>
          )}
          {isThinking && (
            <div className="row gap-3 dda-chat-row">
              <span className="row center dda-chat-agent-tile">
                <Icon name="bot" size={16} />
              </span>
              <span className="dda-chat-thinking" aria-label="Agent is thinking">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </span>
            </div>
          )}
        </div>
      </div>

      {agentError && (
        <div
          role="alert"
          style={{
            margin: "0 24px 12px",
            padding: "10px 12px",
            background: "var(--danger-soft)",
            color: "var(--danger)",
            borderRadius: 8,
            fontSize: 12.5,
          }}
        >
          {agentError}
        </div>
      )}

      <div style={{ padding: "0 24px 20px", flex: "none" }}>
        <ChatComposer
          suggestions={suggestions}
          showSuggestions
          onSend={handleSend}
          disabled={isThinking || isStreaming}
        />
      </div>
    </div>
  );
}

const TOOL_LABEL: Record<string, string> = {
  list_project_repos: "Listing project repos",
  list_files_in_repo: "Browsing repo",
  read_github_file: "Reading file",
  write_repo_file: "Committing file",
  scaffold_helm_chart: "Scaffolding Helm chart",
  list_kubernetes_resources: "Listing cluster resources",
  get_kubernetes_logs: "Fetching pod logs",
  list_ec2_instances: "Listing EC2 instances",
  provision_eks: "Provisioning EKS cluster",
  run_terraform: "Running Terraform",
  list_k8s_manifest_kinds: "Loading manifest options",
  generate_k8s_manifest: "Generating manifest",
  list_helm_chart_fields: "Loading Helm chart options",
  generate_helm_chart: "Generating Helm chart",
  run_helm_upgrade: "Deploying via Helm",
  schedule_deployment: "Scheduling deployment",
  list_scheduled_deployments: "Listing scheduled deployments",
  cancel_scheduled_deployment: "Cancelling scheduled deployment",
  rollback_deployment: "Rolling back deployment",
  list_rollout_history: "Loading rollout history",
};

function ToolCallChip({ call }: { call: ToolCallView }) {
  const label = TOOL_LABEL[call.name] ?? call.name;
  const target = describeToolInput(call.name, call.input);
  const pending = !call.result;
  const failed = call.result && !call.result.ok;
  const dotColor = pending
    ? "var(--text-faint)"
    : failed
      ? "var(--danger)"
      : "var(--ok)";
  return (
    <div
      className="row gap-2"
      style={{
        alignItems: "center",
        fontSize: 12,
        color: failed ? "var(--danger)" : "var(--text-muted)",
        padding: "4px 8px",
        background: "var(--surface-2)",
        borderRadius: 6,
        border: "1px solid var(--border-soft)",
        width: "fit-content",
      }}
    >
      <span
        className="dda-chat-tool-dot"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: dotColor,
          flex: "none",
        }}
        aria-hidden
      />
      <span style={{ fontWeight: 600 }}>{label}</span>
      {target && (
        <span className="mono faint" style={{ fontSize: 11.5 }}>
          {target}
        </span>
      )}
      {pending && <span className="faint" style={{ fontSize: 11 }}>…</span>}
      {failed && <span style={{ fontSize: 11 }}>failed</span>}
    </div>
  );
}

function describeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const str = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : "");
  switch (name) {
    case "read_github_file":
    case "list_files_in_repo":
    case "write_repo_file":
      return str("repoFullName") && str("path")
        ? `${str("repoFullName")}/${str("path")}`
        : str("repoFullName") || str("path");
    case "scaffold_helm_chart":
      return str("repoFullName");
    case "list_kubernetes_resources":
      return str("envKey") && str("kind") ? `${str("envKey")} · ${str("kind")}` : str("envKey") || str("kind");
    case "get_kubernetes_logs":
      return str("envKey") && str("podName") ? `${str("envKey")} · ${str("podName")}` : str("envKey") || str("podName");
    case "run_helm_upgrade":
      return str("envKey") && str("releaseName")
        ? `${str("releaseName")} → ${str("envKey")}`
        : str("envKey") || str("releaseName");
    default:
      return "";
  }
}
