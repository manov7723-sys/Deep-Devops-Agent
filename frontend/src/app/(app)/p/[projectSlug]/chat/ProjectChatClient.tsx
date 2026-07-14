"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Btn, Icon, StatusDot } from "@/components/ui";
import { ChatMsg } from "@/components/domain/ChatMsg";
import { ChatComposer } from "@/components/domain/ChatComposer";
import { ChatHistoryRail } from "@/components/domain/ChatHistoryRail";
import {
  useChatSuggestions,
  useChatThread,
  useChatThreadMessages,
  useChatThreads,
  useClearChat,
  useCreateChatThread,
} from "@/hooks/queries/project";
import { useSendChatMessageStream, type ToolCallView } from "@/hooks/queries/chat-stream";

export interface ProjectChatClientProps {
  slug: string;
}

const RAIL_STORAGE_KEY = "dda:chat:railOpen";

export function ProjectChatClient({ slug }: ProjectChatClientProps) {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  // Rail open/closed — persisted in localStorage so it survives refresh.
  // SSR-safe: start closed, then adopt the stored value on mount to avoid
  // a hydration mismatch flash.
  const [railOpen, setRailOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(RAIL_STORAGE_KEY);
      if (stored !== null) setRailOpen(stored === "1");
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(RAIL_STORAGE_KEY, railOpen ? "1" : "0");
    } catch {}
  }, [railOpen]);

  const { data: threads } = useChatThreads(slug);
  const { data: flatThread } = useChatThread(slug); // fallback for the initial paint
  const { data: activeMessages } = useChatThreadMessages(slug, activeThreadId);
  const { data: suggestions } = useChatSuggestions(slug);
  const { send, status } = useSendChatMessageStream(slug);
  const clearChat = useClearChat(slug);
  const createChatThread = useCreateChatThread(slug);

  // Adopt the most-recent thread as active on first load (once the list arrives).
  useEffect(() => {
    if (activeThreadId) return;
    if (!threads || threads.length === 0) return;
    setActiveThreadId(threads[0]!.id);
  }, [threads, activeThreadId]);

  const isThinking = status.state === "sending";
  const isStreaming = status.state === "streaming";
  const partial = isStreaming ? status.partial : "";
  const agentError = status.state === "error" ? status.message : null;
  const toolCalls =
    status.state === "streaming" || status.state === "sending" || status.state === "error"
      ? status.toolCalls
      : [];
  const busy = isThinking || isStreaming || createChatThread.isPending;

  const messages = activeThreadId ? (activeMessages ?? []) : (flatThread ?? []);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, partial, isThinking]);

  function handleSend(text: string) {
    send(text, {
      threadId: activeThreadId,
      onThreadResolved: (id) => {
        if (id !== activeThreadId) setActiveThreadId(id);
      },
    }).catch(() => {});
  }

  async function handleNewChat() {
    if (busy) return;
    try {
      const res = await createChatThread.mutateAsync(undefined);
      setActiveThreadId(res.threadId);
    } catch {
      // mutation surfaces its own error state; nothing else to do here.
    }
  }

  async function handleClear() {
    if (busy) return;
    await clearChat.mutateAsync();
    setActiveThreadId(null);
  }

  return (
    <div className={`dda-chat-shell${railOpen ? "" : " is-rail-closed"}`}>
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
            disabled={clearChat.isPending || busy || messages.length === 0}
            onClick={handleClear}
          >
            Clear
          </Btn>
          <Btn
            size="icon"
            variant="outline"
            aria-label={railOpen ? "Hide recent chats" : "Show recent chats"}
            aria-pressed={railOpen}
            title={railOpen ? "Hide recent chats" : "Show recent chats"}
            onClick={() => setRailOpen((v) => !v)}
          >
            <Icon name={railOpen ? "chevR" : "chevL"} size={16} />
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
      <ChatHistoryRail
        slug={slug}
        activeThreadId={activeThreadId}
        onSelect={(id) => !busy && setActiveThreadId(id)}
        onNewChat={handleNewChat}
        disabled={busy}
      />
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
