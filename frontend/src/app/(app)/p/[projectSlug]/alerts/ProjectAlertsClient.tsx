"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { Route } from "next";
import { Block, Btn, ChipGroup, PageHead, Stat } from "@/components/ui";

import { useAlertAction, useAlerts } from "@/hooks/queries/project";
import type { AlertCategory } from "@/lib/legacy-types";

const CAT_OPTIONS: Array<{ value: AlertCategory | "All"; label: string }> = [
  { value: "All", label: "All" },
  { value: "Security", label: "Security" },
  { value: "Performance", label: "Performance" },
  { value: "Compliance", label: "Compliance" },
  { value: "Reliability", label: "Reliability" },
];

export function ProjectAlertsClient({ slug }: { slug: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const cat = (sp.get("cat") as AlertCategory | "All" | null) ?? "All";
  const { data: alerts } = useAlerts(slug, cat);
  const { data: allAlerts } = useAlerts(slug, "All");
  const action = useAlertAction(slug);

  function setCat(v: AlertCategory | "All") {
    const p = new URLSearchParams(sp);
    if (v === "All") p.delete("cat");
    else p.set("cat", v);
    const q = p.toString();
    router.replace((q ? `${pathname}?${q}` : pathname) as Route);
  }

  const totals = allAlerts ?? [];
  const open = totals.filter((a) => a.status === "open").length;
  const high = totals.filter((a) => a.sev === "high").length;
  const security = totals.filter((a) => a.cat === "Security").length;

  return (
    <div className="col gap-5">
      <PageHead
        title="Alerts"
        sub="Security findings and operational alarms across this project — raised by the agents."
        actions={
          <>
            <Btn variant="outline" icon="settings">Alert rules</Btn>
            <Btn variant="outline" icon="check">Acknowledge all</Btn>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        <Stat label="Open alerts" value={open} icon="alert" sub={`${totals.length} total`} />
        <Stat label="High severity" value={high} icon="shield" sub="needs action now" />
        <Stat label="Security findings" value={security} icon="lock" sub="by Security Sentinel" />
        <Stat label="Mean time to ack" value="14m" icon="clock" sub="last 30 days" />
      </div>

      <ChipGroup options={CAT_OPTIONS} value={cat} onChange={setCat} ariaLabel="Alert category" />

      {alerts ? (
        alerts.length === 0 ? (
          <Block>
            <Block.Empty icon="alert" title="No alerts in this category" description="Nice." />
          </Block>
        ) : (
          <div className="col gap-3">
            {alerts.map((a) => (

                alert={a}
                onAck={(id) => action.mutate({ id, action: "ack" })}
                onResolve={(id) => action.mutate({ id, action: "resolve" })}
                onAsk={() => router.push(`/p/${slug}/chat` as Route)}
              />
            ))}
          </div>
        )
      ) : (
        <Block>
          <Block.Loading />
        </Block>
      )}
    </div>
  );
}
