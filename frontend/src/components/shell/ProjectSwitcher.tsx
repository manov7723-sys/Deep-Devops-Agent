"use client";

import Link from "next/link";
import type { Route } from "next";
import { Menu, MenuItem, MenuLabel, MenuSeparator, Icon } from "@/components/ui";
import { useProjects } from "@/hooks/queries/projects";

export interface ProjectSwitcherProps {
  activeSlug: string;
}

function ProjectAvatar({ name, hue, size = 22 }: { name: string; hue: number; size?: number }) {
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.46,
        borderRadius: size <= 24 ? 6 : 8,
        background: `linear-gradient(135deg, oklch(0.62 0.16 ${hue}), oklch(0.5 0.17 ${(hue + 30) % 360}))`,
      }}
    >
      {name[0]}
    </span>
  );
}

export function ProjectSwitcher({ activeSlug }: ProjectSwitcherProps) {
  const { data: projects } = useProjects();
  const active = projects?.find((p) => p.slug === activeSlug) ?? projects?.[0];
  if (!projects || !active) {
    return <div className="skel" style={{ height: 40, width: "100%", borderRadius: 9 }} />;
  }
  return (
    <Menu
      width={264}
      align="start"
      trigger={
        <button className="dda-project-switcher row between" aria-label="Switch project">
          <span className="row gap-2">
            <ProjectAvatar name={active.name} hue={active.colorHue} size={24} />
            <span style={{ fontSize: 13, fontWeight: 700 }}>{active.name}</span>
          </span>
          <Icon name="chevUD" size={15} style={{ color: "var(--text-faint)" }} />
        </button>
      }
    >
      <MenuLabel>Switch project</MenuLabel>
      {projects.map((p) => (
        <MenuItem key={p.id}>
          <Link
            href={`/p/${p.slug}/dashboard` as Route}
            className="row gap-2"
            style={{ flex: 1, color: "inherit" }}
          >
            <ProjectAvatar name={p.name} hue={p.colorHue} />
            <span className="grow" style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
            {p.id === active.id && (
              <Icon name="check" size={15} style={{ color: "var(--accent)" }} />
            )}
          </Link>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon="plus">
        <Link href={"/u/projects" as Route} style={{ color: "inherit" }}>New project</Link>
      </MenuItem>
    </Menu>
  );
}
