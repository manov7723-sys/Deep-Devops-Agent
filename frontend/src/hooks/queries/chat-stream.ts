"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SeedChatMessage } from "@/lib/legacy-types";

export type ToolCallView = {
  toolUseId: string;
  name: string;
  input?: unknown;
  result?: { ok: boolean; summary: string };
};

type Streaming =
  | { state: "idle" }
  | { state: "sending"; toolCalls: ToolCallView[] }
  | { state: "streaming"; partial: string; toolCalls: ToolCallView[] }
  | { state: "error"; message: string; toolCalls: ToolCallView[] };

/**
 * Streaming chat send. Calls /projects/[slug]/chat/stream (SSE), pipes
 * deltas into a local partial buffer the UI can render live, and on `done`
 * patches the react-query chat cache with the real DB rows so the message
 * is preserved on subsequent re-renders.
 */
export type SendOptions = {
  /** Target thread. When omitted the server uses the most-recent or creates one. */
  threadId?: string | null;
  /**
   * Fires once the server resolves which thread this turn landed in. Use this
   * to switch the client's active thread when the send started with no active
   * thread and the server had to create one.
   */
  onThreadResolved?: (threadId: string) => void;
};

export function useSendChatMessageStream(slug: string) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Streaming>({ state: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (text: string, opts: SendOptions = {}) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // Cache key is per-thread when known, else falls back to the flat chat
      // cache (which the initial load uses). Compute it up front and reuse.
      const cacheKey: readonly unknown[] = opts.threadId
        ? ["p", slug, "chat", "threads", opts.threadId]
        : ["p", slug, "chat"];

      // Optimistic user message immediately on the page.
      const prev = qc.getQueryData<SeedChatMessage[]>(cacheKey) ?? [];
      const optimisticId = `optim-${Date.now()}`;
      qc.setQueryData<SeedChatMessage[]>(cacheKey, [
        ...prev,
        { id: optimisticId, role: "user", text },
      ]);
      const toolCalls: ToolCallView[] = [];
      setStatus({ state: "sending", toolCalls });

      let partial = "";
      // Effective cache key gets rewritten once the server resolves the
      // thread id (server may have created one). Everything after `thread`
      // event uses this to write back to the right cache.
      let effectiveKey = cacheKey;
      try {
        const res = await fetch(`/api/v1/projects/${slug}/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, ...(opts.threadId ? { threadId: opts.threadId } : {}) }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`Server returned ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frame separator is "\n\n". Process completed frames; keep
          // the trailing partial frame in the buffer for the next chunk.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            if (!frame.trim()) continue;
            let event = "message";
            let data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }

            if (event === "thread") {
              const { id: resolvedId } = parsed as { id: string };
              // Server told us the real thread. If it differs from what we
              // optimistically used, migrate the optimistic message across
              // caches so the UI stays consistent.
              const newKey: readonly unknown[] = ["p", slug, "chat", "threads", resolvedId];
              if (JSON.stringify(newKey) !== JSON.stringify(effectiveKey)) {
                const cur = qc.getQueryData<SeedChatMessage[]>(effectiveKey) ?? [];
                qc.setQueryData<SeedChatMessage[]>(newKey, cur);
                effectiveKey = newKey;
              }
              opts.onThreadResolved?.(resolvedId);
            } else if (event === "user_message") {
              const msg = parsed as SeedChatMessage;
              qc.setQueryData<SeedChatMessage[]>(effectiveKey, (cur) =>
                (cur ?? []).map((m) => (m.id === optimisticId ? msg : m)),
              );
            } else if (event === "delta") {
              const { text: chunk } = parsed as { text: string };
              partial += chunk;
              setStatus({ state: "streaming", partial, toolCalls: [...toolCalls] });
            } else if (event === "tool_call_start") {
              const { toolUseId, name } = parsed as { toolUseId: string; name: string };
              toolCalls.push({ toolUseId, name });
              setStatus({ state: "streaming", partial, toolCalls: [...toolCalls] });
            } else if (event === "tool_call_input") {
              const { toolUseId, input } = parsed as { toolUseId: string; input: unknown };
              const idx = toolCalls.findIndex((t) => t.toolUseId === toolUseId);
              if (idx >= 0) toolCalls[idx] = { ...toolCalls[idx]!, input };
              setStatus({ state: "streaming", partial, toolCalls: [...toolCalls] });
            } else if (event === "tool_call_result") {
              const { toolUseId, ok, summary } = parsed as {
                toolUseId: string;
                ok: boolean;
                summary: string;
              };
              const idx = toolCalls.findIndex((t) => t.toolUseId === toolUseId);
              if (idx >= 0)
                toolCalls[idx] = { ...toolCalls[idx]!, result: { ok, summary } };
              setStatus({ state: "streaming", partial, toolCalls: [...toolCalls] });
            } else if (event === "turn_end") {
              // turn boundary — nothing for the UI to do, mostly a debug marker.
            } else if (event === "done") {
              const msg = parsed as SeedChatMessage;
              qc.setQueryData<SeedChatMessage[]>(effectiveKey, (cur) => [
                ...(cur ?? []),
                msg,
              ]);
              // Bubble the update into the flat chat cache too (initial-load
              // path) and the threads list so the rail's timestamps refresh.
              qc.invalidateQueries({ queryKey: ["p", slug, "chat", "threads"] });
              setStatus({ state: "idle" });
            } else if (event === "error") {
              const { message } = parsed as { code: string; message: string };
              setStatus({ state: "error", message, toolCalls: [...toolCalls] });
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          setStatus({ state: "idle" });
          return;
        }
        setStatus({
          state: "error",
          message: err instanceof Error ? err.message : "Could not send message.",
          toolCalls: [...toolCalls],
        });
      }
    },
    [slug, qc],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setStatus({ state: "idle" });
  }, []);

  return { send, cancel, status };
}
