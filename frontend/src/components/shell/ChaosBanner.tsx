"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Btn, Icon } from "@/components/ui";
import { useChaos, getEffectiveChaos } from "@/lib/api/chaos";

/**
 * Mounted inside AppShell. Subscribes to React Query cache + chaos store.
 * Shows a warning banner when chaos is engaged so the demo is unambiguous,
 * and counts errored queries so the user knows the failures are mock-injected.
 */
export function ChaosBanner() {
  const chaos = useChaos();
  const qc = useQueryClient();
  const [errored, setErrored] = useState(0);

  useEffect(() => {
    const unsub = qc.getQueryCache().subscribe((e) => {
      if (e.type === "updated" && e.action?.type === "error") {
        setErrored((n) => n + 1);
      }
    });
    return () => unsub();
  }, [qc]);

  useEffect(() => {
    setErrored(0);
  }, [chaos.latency, chaos.failure]);

  // Effective chaos honors ?chaos= URL params too — same as the api.client does.
  const effective = getEffectiveChaos();
  const isOn =
    chaos.latency !== "off" ||
    chaos.failure !== "off" ||
    effective.latencyMs > 0 ||
    effective.failureRate > 0;
  if (!isOn) return null;

  const latencyLabel =
    chaos.latency !== "off" ? chaos.latency : effective.latencyMs > 0 ? `${effective.latencyMs}ms` : "off";
  const failureLabel =
    chaos.failure !== "off"
      ? chaos.failure
      : effective.failureRate > 0
        ? `${Math.round(effective.failureRate * 100)}%`
        : "off";

  return (
    <div className="dda-chaos-banner" role="status">
      <span className="row gap-2">
        <Icon name="alert" size={15} />
        Mock chaos is on — latency: <b>{latencyLabel}</b>, failure: <b>{failureLabel}</b>
        {errored > 0 && <span>· {errored} injected failures</span>}
      </span>
      <div className="row gap-2">
        <Btn size="sm" variant="ghost" onClick={() => qc.invalidateQueries()}>
          Retry all
        </Btn>
        <Btn size="sm" variant="ghost" onClick={chaos.reset}>
          Turn off
        </Btn>
      </div>
    </div>
  );
}
