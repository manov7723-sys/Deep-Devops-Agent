"use client";

import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { Block, Btn, PageHead, VirtualList } from "@/components/ui";
import { EnvFilter, type EnvFilterValue } from "@/components/domain/EnvFilter";
import { ActivityRow } from "@/components/domain/ActivityRow";
import { useProjectActivity } from "@/hooks/queries/project";
import type { SeedActivity } from "@/lib/legacy-types";

/**
 * Inflate the seed activity into a larger feed (×30) so we can demonstrate
 * the virtualization. Each row gets a stable synthetic id.
 */
function inflate(items: SeedActivity[], factor: number): SeedActivity[] {
  const out: SeedActivity[] = [];
  for (let i = 0; i < factor; i++) {
    for (const a of items) {
      out.push({ ...a, id: `${a.id}_${i}` });
    }
  }
  return out;
}

export function ProjectActivityClient({ slug }: { slug: string }) {
  const sp = useSearchParams();
  const env = (sp.get("env") as EnvFilterValue | null) ?? "all";
  const { data } = useProjectActivity(slug);

  const inflated = useMemo(() => inflate(data ?? [], 30), [data]);
  const filtered = env === "all"
    ? inflated
    : inflated.filter((a) => a.env === env || a.env === "shared");

  return (
    <div className="col gap-5">
      <PageHead
        title="Activity"
        sub="Everything you and the agents have done across this project."
        actions={
          <>
            <Btn variant="outline" icon="filter">Filter</Btn>
            <Btn variant="outline" icon="download">Export</Btn>
          </>
        }
      />
      <EnvFilter />

      <Block>
        {data ? (
          filtered.length === 0 ? (
            <Block.Empty
              icon="activity"
              title="No activity for this filter"
              description="Switch envs to see more."
            />
          ) : (
            <VirtualList
              items={filtered}
              estimateSize={64}
              height={620}
              getKey={(a) => a.id}
              renderItem={(a) => <ActivityRow a={a} />}
            />
          )
        ) : (
          <Block.Loading />
        )}
      </Block>
      <p className="faint" style={{ fontSize: 11.5, textAlign: "center" }}>
        Showing {filtered.length} of {inflated.length} entries · virtualized via TanStack Virtual
      </p>
    </div>
  );
}
