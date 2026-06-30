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
export function useSendChatMessageStream(slug: string) {
  const qc = useQueryClient();
  const cacheKey = ["p", slug, "chat"] as const;
  const [status, setStatus] = useState<Streaming>({ state: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (text: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

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
      try {
        const res = await fetch(`/api/v1/projects/${slug}/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
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

            if (event === "user_message") {
              const msg = parsed as SeedChatMessage;
              qc.setQueryData<SeedChatMessage[]>(cacheKey, (cur) =>
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
              qc.setQueryData<SeedChatMessage[]>(cacheKey, (cur) => [
                ...(cur ?? []),
                msg,
              ]);
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
    [slug, qc, cacheKey],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setStatus({ state: "idle" });
  }, []);

  return { send, cancel, status };
}
