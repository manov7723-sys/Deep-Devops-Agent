"use client";

import { useSearchParams } from "next/navigation";
import { Block, Btn, PageHead, Stat, TileGrid } from "@/components/ui";
import { EnvFilter, type EnvFilterValue } from "@/components/domain/EnvFilter";
import { TaskRow } from "@/components/domain/TaskRow";
import { useProjectTasks, useRunTask } from "@/hooks/queries/project";

export function ProjectTasksClient({ slug }: { slug: string }) {
  const sp = useSearchParams();
  const env = (sp.get("env") as EnvFilterValue | null) ?? "all";
  const { data: tasks } = useProjectTasks(slug, env);
  const runTask = useRunTask(slug);

  const running = tasks?.filter((t) => t.status === "running").length ?? 0;
  const findings = (tasks?.filter((t) => t.status === "warn") ?? []).length;

  return (
    <div className="col gap-5">
      <PageHead
        title="Background tasks"
        sub="Scheduled agent jobs — security, backups, drift, cost &amp; compliance."
        actions={
          <>
            <Btn variant="outline" icon="clock">
              Schedules
            </Btn>
            <Btn variant="primary" icon="plus">
              New task
            </Btn>
          </>
        }
      />
      <EnvFilter />

      <TileGrid minTile={180} maxTile="1fr">
        <Stat label="Active agents" value="5" icon="bot" sub="across 7 environments" />
        <Stat label="Runs today" value="148" icon="refresh" sub={`${running} currently running`} />
        <Stat
          label="Open findings"
          value={findings}
          icon="alert"
          sub={findings === 0 ? "all clear" : "review on demand"}
        />
        <Stat label="Last full sweep" value="12m ago" icon="check" sub="all envs scanned" />
      </TileGrid>

      {tasks ? (
        tasks.length === 0 ? (
          <Block>
            <Block.Empty
              icon="tasks"
              title="No tasks for this filter"
              description="Switch to a different environment or create a new task."
            />
          </Block>
        ) : (
          <div className="col gap-3">
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} onRun={(id) => runTask.mutate(id)} />
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
