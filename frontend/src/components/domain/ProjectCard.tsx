"use client";

import Link from "next/link";
import type { Route } from "next";
import { Btn, Icon, StatusDot } from "@/components/ui";
import { ProjectAvatar } from "./ProjectAvatar";
import type { Project } from "@/hooks/queries/projects";

export type ProjectCardVariant = "tile" | "row" | "create-new";

export interface ProjectCardProps {
  project?: Project;
  variant?: ProjectCardVariant;
  onCreate?: () => void;
  /** When provided, a delete (trash) button shows on the tile. */
  onDelete?: () => void;
}

export function ProjectCard({ project, variant = "tile", onCreate, onDelete }: ProjectCardProps) {
  if (variant === "create-new") {
    return (
      <button
        type="button"
        className="card card-pad col center gap-3 dda-project-create"
        onClick={onCreate}
      >
        <span className="row center dda-project-create-icon">
          <Icon name="plus" size={22} />
        </span>
        <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>
          Create a project
        </span>
        <span className="faint" style={{ fontSize: 12 }}>
          Connect a repo to get started
        </span>
      </button>
    );
  }
  if (!project) return null;

  const href = `/p/${project.slug}/dashboard` as Route;
  const health = project.health;
  const healthLabel = health === "ok" ? "Healthy" : health === "warn" ? "Attention" : "Degraded";

  if (variant === "row") {
    return (
      <div className="row between gap-3" style={{ minWidth: 0 }}>
        <div className="row gap-3" style={{ minWidth: 0 }}>
          <ProjectAvatar name={project.name} hue={project.colorHue} />
          <div className="col" style={{ lineHeight: 1.35, minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{project.name}</span>
            <span className="faint" style={{ fontSize: 12 }}>
              {project.envCount} environments · {project.repoCount} repos
              {project.cloud.length > 0 ? ` · ${project.cloud.join(", ")}` : ""}
            </span>
          </div>
        </div>
        <div className="row gap-3 nowrap">
          <StatusDot tone={health} label={healthLabel} />
          <Link href={href} className="btn outline sm">
            Open
          </Link>
        </div>
      </div>
    );
  }

  // tile
  return (
    <Link href={href} className="card card-pad col gap-4 dda-project-tile">
      <div className="row between">
        <ProjectAvatar name={project.name} hue={project.colorHue} size={44} />
        <div className="row gap-2" style={{ alignItems: "center" }}>
          <StatusDot tone={health} pulse={health === "ok"} />
          {onDelete && (
            <button
              type="button"
              aria-label="Delete project"
              className="row center"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(); }}
              style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid var(--border-soft)", background: "var(--surface-1)", color: "var(--text-faint)", cursor: "pointer" }}
            >
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="col gap-1">
        <span style={{ fontWeight: 700, fontSize: 15 }}>{project.name}</span>
        <span className="faint" style={{ fontSize: 12.5 }}>
          {project.cloud.length > 0 ? project.cloud.join(" · ") : "No cloud yet"}
        </span>
      </div>
      <div className="row gap-4" style={{ fontSize: 12.5 }}>
        <span className="muted">
          <b style={{ color: "var(--text)" }}>{project.envCount}</b> envs
        </span>
        <span className="muted">
          <b style={{ color: "var(--text)" }}>{project.repoCount}</b> repos
        </span>
      </div>
      <div className="divider" />
      <Btn variant="outline" iconRight="chevR" block>
        Open workspace
      </Btn>
    </Link>
  );
}
