"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@/components/ui";
import { api } from "@/lib/api/client";

/**
 * Global live-alert banner. Mounted in AppShell, it polls /alerts/live every
 * minute — which re-syncs CloudWatch alarm state — and, the moment a metric
 * crosses its threshold, surfaces a prominent banner at the top of the app
 * without the user having to open the Alerts page. High-severity alerts also
 * flip the shell into an attention "alert mode" (pulsing red edge).
 */
type LiveAlert = {
  id: string;
  title: string;
  detail: string;
  severity: "low" | "medium" | "high";
  category: string;
  resource: string;
  detectedAt: string;
  projectSlug: string;
  projectName: string;
  envKey: string | null;
};

export function AlertBanner() {
  const { data } = useQuery<{ ok: boolean; alerts: LiveAlert[] }>({
    queryKey: ["alerts", "live"],
    queryFn: () => api.get<{ ok: boolean; alerts: LiveAlert[] }>("/alerts/live"),
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const alerts = data?.alerts ?? [];
  // Re-show the banner whenever the set of open alerts changes (a new alert
  // fires or one resolves), even if the user dismissed the previous set.
  const signature = alerts.map((a) => a.id).sort().join(",");
  const [dismissedSig, setDismissedSig] = useState<string>("");

  const visible = alerts.length > 0 && dismissedSig !== signature;
  const high = alerts.some((a) => a.severity === "high");

  // High-severity "alert mode": pulsing red edge on the whole app shell.
  useEffect(() => {
    const shell = document.querySelector(".dda-shell");
    if (!shell) return;
    shell.classList.toggle("dda-alert-mode", visible && high);
    return () => shell.classList.remove("dda-alert-mode");
  }, [visible, high]);

  if (!visible) return null;

  const top = alerts[0];
  const where = top.envKey ? `${top.projectName} · ${top.envKey}` : top.projectName;

  return (
    <div className={`dda-alert-banner${high ? " high" : ""}`} role="alert" aria-live="assertive">
      <span className="dda-alert-pulse" aria-hidden />
      <Icon name="alert" size={16} />
      <span className="dda-alert-text">
        <strong>
          {alerts.length} active alert{alerts.length > 1 ? "s" : ""}
        </strong>
        {" — "}
        {top.title}
        <span className="dda-alert-where"> · {where}</span>
        {alerts.length > 1 && <span className="dda-alert-where"> · +{alerts.length - 1} more</span>}
      </span>
      <Link href={`/p/${top.projectSlug}/alerts`} className="dda-alert-link">
        View alerts
      </Link>
      <button
        type="button"
        className="dda-alert-x"
        onClick={() => setDismissedSig(signature)}
        aria-label="Dismiss"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
