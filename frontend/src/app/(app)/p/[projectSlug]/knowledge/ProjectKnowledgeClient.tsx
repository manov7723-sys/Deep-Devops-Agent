"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Block, Btn, PageHead, SearchFilter, TileGrid } from "@/components/ui";
import { EnvFilter, type EnvFilterValue } from "@/components/domain/EnvFilter";
import { KnowledgeCard } from "@/components/domain/KnowledgeCard";
import { useKnowledge } from "@/hooks/queries/project";
import { NewKnowledgeDocModal } from "@/components/modals/NewKnowledgeDocModal";

export function ProjectKnowledgeClient({ slug }: { slug: string }) {
  const sp = useSearchParams();
  const q = sp.get("q") ?? "";
  const env = (sp.get("env") as EnvFilterValue | null) ?? "all";
  const { data: docs } = useKnowledge(slug, q, env);
  const [newDocOpen, setNewDocOpen] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // All distinct tags across the project's docs — used for chip filter row.
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of docs ?? []) {
      for (const t of d.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [docs]);

  const filteredDocs = useMemo(() => {
    if (!docs) return [];
    if (!activeTag) return docs;
    return docs.filter((d) => (d.tags ?? []).includes(activeTag));
  }, [docs, activeTag]);

  // Group by type — Doc | Runbook.
  const docsByType = useMemo(() => {
    const map: Record<"Doc" | "Runbook", typeof filteredDocs> = { Doc: [], Runbook: [] };
    for (const d of filteredDocs) {
      const t = ((d as { type?: string }).type ?? "Doc") as "Doc" | "Runbook";
      (map[t] ?? map.Doc).push(d);
    }
    return map;
  }, [filteredDocs]);

  return (
    <div className="col gap-5">
      <PageHead
        title="Knowledge base"
        sub="Runbooks, conventions and architecture context the agents read from."
        actions={
          <>
            <Btn variant="outline" icon="book">
              Import from repo
            </Btn>
            <Btn variant="primary" icon="plus" onClick={() => setNewDocOpen(true)}>
              New doc
            </Btn>
          </>
        }
      />

      <div className="row between wrap gap-3">
        <EnvFilter />
        <SearchFilter placeholder="Search docs…" width={260} />
      </div>

      {tagCounts.length > 0 && (
        <div className="row wrap gap-2" aria-label="Filter by tag">
          <button
            type="button"
            className={`chip ${activeTag === null ? "active" : ""}`}
            onClick={() => setActiveTag(null)}
          >
            All ({docs?.length ?? 0})
          </button>
          {tagCounts.map(([tag, n]) => (
            <button
              key={tag}
              type="button"
              className={`chip ${activeTag === tag ? "active" : ""}`}
              onClick={() => setActiveTag((prev) => (prev === tag ? null : tag))}
            >
              {tag}{" "}
              <span className="faint" style={{ marginLeft: 4 }}>
                {n}
              </span>
            </button>
          ))}
        </div>
      )}

      {!docs ? (
        <Block>
          <Block.Loading />
        </Block>
      ) : filteredDocs.length === 0 ? (
        <Block>
          <Block.Empty
            icon="book"
            title={activeTag ? `No docs tagged "${activeTag}"` : "No docs match this search"}
            description="Try a different term, clear the tag filter, or create a new doc."
          />
        </Block>
      ) : (
        <div className="col gap-6">
          <KnowledgeSection
            label="Documentation"
            count={docsByType.Doc.length}
            docs={docsByType.Doc}
            highlight={q}
          />
          <KnowledgeSection
            label="Runbooks"
            count={docsByType.Runbook.length}
            docs={docsByType.Runbook}
            highlight={q}
          />
        </div>
      )}

      <NewKnowledgeDocModal open={newDocOpen} onOpenChange={setNewDocOpen} projectSlug={slug} />
    </div>
  );
}

function KnowledgeSection({
  label,
  count,
  docs,
  highlight,
}: {
  label: string;
  count: number;
  docs: ReadonlyArray<Parameters<typeof KnowledgeCard>[0]["doc"]>;
  highlight: string;
}) {
  if (count === 0) return null;
  return (
    <div className="col gap-3">
      <div className="row gap-2" style={{ alignItems: "baseline" }}>
        <span
          style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase" }}
        >
          {label}
        </span>
        <span className="faint" style={{ fontSize: 12 }}>
          {count}
        </span>
      </div>
      <TileGrid minTile={320}>
        {docs.map((d) => (
          <KnowledgeCard key={d.id} doc={d} highlight={highlight} />
        ))}
      </TileGrid>
    </div>
  );
}
