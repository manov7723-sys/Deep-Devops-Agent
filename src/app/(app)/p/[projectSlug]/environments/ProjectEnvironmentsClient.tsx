"use client";

import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { Route } from "next";
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Badge,
  Block,
  Btn,
  ConfigRow,
  DataTable,
  Icon,
  PageHead,
  StatusDot,
  Toggle,
} from "@/components/ui";
import { useProjectEnvs, useProjectWorkloads, type ProjectEnv } from "@/hooks/queries/project";
import type { EnvId, SeedEnv, SeedWorkload } from "@/lib/legacy-types";
import { AddEnvModal } from "@/components/modals/AddEnvModal";
import { EditEnvModal } from "@/components/modals/EditEnvModal";

export function ProjectEnvironmentsClient({ slug }: { slug: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const selectedFromUrl = sp.get("focus") as EnvId | null;

  const { data: envs } = useProjectEnvs(slug);
  const [selected, setSelected] = useState<EnvId>(selectedFromUrl ?? "release");
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // sync URL when changed
  function pickEnv(id: EnvId) {
    setSelected(id);
    const p = new URLSearchParams(sp);
    p.set("focus", id);
    router.replace((`${pathname}?${p.toString()}`) as Route);
  }

  const focused = envs?.find((e) => e.id === selected) ?? envs?.[0];
  const { data: workloads } = useProjectWorkloads(slug, focused?.id ?? "all");

  const wlColumns = useMemo<ColumnDef<SeedWorkload>[]>(
    () => [
      {
        id: "name",
        header: "Workload",
        cell: ({ row }) => (
          <div className="row gap-2">
            <Icon name="box" size={15} style={{ color: "var(--text-faint)" }} />
            <span style={{ fontWeight: 600 }}>{row.original.name}</span>
          </div>
        ),
      },
      { id: "replicas", header: "Replicas", cell: ({ row }) => <span className="mono">{row.original.replicas}</span> },
      { id: "cpu", header: "CPU", cell: ({ row }) => <span className="mono" style={{ fontSize: 12 }}>{row.original.cpu}</span> },
      { id: "mem", header: "Memory", cell: ({ row }) => <span className="mono" style={{ fontSize: 12 }}>{row.original.mem}</span> },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <StatusDot
            tone={row.original.status}
            label={row.original.status === "ok" ? "Healthy" : row.original.status === "warn" ? "Degraded" : "Down"}
          />
        ),
      },
    ],
    [],
  );

  return (
    <div className="col gap-5">
      <PageHead
        title="Environments"
        sub="Map branches to deploy targets and promote builds across stages."
        actions={
          <Btn variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            New environment
          </Btn>
        }
      />
      <AddEnvModal open={addOpen} onOpenChange={setAddOpen} projectSlug={slug} />

      <Block>
        <Block.Header>
          <Block.Title>Promotion flow</Block.Title>
        </Block.Header>
        <Block.Body>
          {envs ? (
            <div className="row gap-2 wrap" style={{ alignItems: "stretch" }}>
              {envs.map((e, i) => (
                <PromoTile
                  key={e.id}
                  e={e}
                  active={focused?.id === e.id}
                  onPick={() => pickEnv(e.id)}
                  showArrow={i < envs.length - 1}
                />
              ))}
            </div>
          ) : (
            <Block.Loading />
          )}
        </Block.Body>
      </Block>

      {focused && (
        <div className="dda-proj-dash-grid">
          <Block>
            <Block.Header>
              <Block.Title>{focused.name} configuration</Block.Title>
            </Block.Header>
            <Block.Body>
              <div className="col gap-3">
                <ConfigRow label="Source branch" value={<code className="mono">{focused.branch}</code>} />
                <ConfigRow
                  label="Public URL"
                  value={
                    <a className="mono" style={{ color: "var(--accent)" }}>
                      {focused.url}
                    </a>
                  }
                />
                <ConfigRow
                  label="Cloud target"
                  value={<Badge icon="cloud">{focused.id === "alpha" ? "GCP · us-central1" : "AWS · us-east-1"}</Badge>}
                />
                <ConfigRow label="Auto-deploy" value={<Toggle checked={focused.auto} onCheckedChange={() => {}} ariaLabel="Auto-deploy" />} />
                <ConfigRow label="Require approval" value={<Toggle checked={!focused.auto} onCheckedChange={() => {}} ariaLabel="Require approval" />} />
                <ConfigRow
                  label="Terraform workspace"
                  value={
                    <code className="mono">
                      {(focused as unknown as ProjectEnv).terraformWorkspace ?? `${slug}-${focused.id}`}
                    </code>
                  }
                />
                <div className="divider" />
                <div className="row gap-2">
                  <Link
                    href={`/p/${slug}/cicd?env=${focused.id}&trigger=1` as Route}
                    className="btn primary grow"
                  >
                    <Icon name="rocket" size={16} />
                    Deploy now
                  </Link>
                  <Btn
                    variant="outline"
                    size="icon"
                    aria-label="Environment settings"
                    onClick={() => setEditOpen(true)}
                  >
                    <Icon name="settings" size={16} />
                  </Btn>
                </div>
              </div>
            </Block.Body>
          </Block>

          <Block>
            <Block.Header>
              <Block.Title>Workloads in {focused.name}</Block.Title>
              <Block.Actions>
                <Badge tone="info">{workloads?.length ?? 0} deployments</Badge>
              </Block.Actions>
            </Block.Header>
            <DataTable
              data={workloads ?? []}
              columns={wlColumns}
              rowKey={(w) => w.id}
              emptyIcon="box"
              emptyTitle="No workloads in this environment"
            />
          </Block>
        </div>
      )}

      {focused && (
        <EditEnvModal
          open={editOpen}
          onOpenChange={setEditOpen}
          projectSlug={slug}
          env={focused as unknown as ProjectEnv}
        />
      )}
    </div>
  );
}

function PromoTile({
  e,
  active,
  onPick,
  showArrow,
}: {
  e: SeedEnv;
  active: boolean;
  onPick: () => void;
  showArrow: boolean;
}) {
  return (
    <>
      <button type="button" onClick={onPick} className="dda-env-tile col gap-2" data-active={active ? "true" : undefined}>
        <div className="row between">
          <span className="row gap-2" style={{ fontWeight: 700 }}>
            <span className={`dot ${e.tone}`} />
            {e.name}
          </span>
          <Badge tone={e.tone}>{e.id}</Badge>
        </div>
        <span className="mono faint" style={{ fontSize: 11.5 }}>{e.branch}</span>
        <span className="mono" style={{ fontSize: 12 }}>{e.url}</span>
        <div className="row gap-2 muted" style={{ fontSize: 11.5 }}>
          <Icon name={e.auto ? "zap" : "lock"} size={13} />
          {e.auto ? "Auto-deploy" : "Manual approval"}
        </div>
      </button>
      {showArrow && (
        <div className="row center" style={{ flex: "none", color: "var(--text-faint)" }}>
          <Icon name="chevR" size={20} />
        </div>
      )}
    </>
  );
}
