"use client";

import Link from "next/link";
import type { Route } from "next";
import { Btn, Icon, Menu, MenuItem, MenuLabel } from "@/components/ui";
import { AREA_META, type LayoutArea } from "./nav-registry";
import { useProjects } from "@/hooks/queries/projects";

export interface WorkspaceSwitcherProps {
  area: LayoutArea;
  isSuperAdmin: boolean;
}

/**
 * Workspace switcher (NOT a permission elevator). The Admin entry is gated by
 * the isSuperAdmin flag — non-admins never see it. Even if they typed the URL,
 * middleware + the (app)/admin/layout.tsx guard would 404.
 */
export function WorkspaceSwitcher({ area, isSuperAdmin }: WorkspaceSwitcherProps) {
  const meta = AREA_META[area];
  const { data: projects } = useProjects();
  const firstProject = projects?.[0];

  return (
    <Menu
      width={236}
      align="end"
      trigger={
        <Btn variant="outline" size="sm" icon={meta.icon} iconRight="chevD">
          {meta.label}
        </Btn>
      }
    >
      <MenuLabel>Switch view</MenuLabel>
      <MenuItem icon="user">
        <Link href={"/u/dashboard" as Route} style={{ color: "inherit" }}>
          My Account
        </Link>
      </MenuItem>
      {firstProject && (
        <MenuItem icon="box">
          <Link href={`/p/${firstProject.slug}/dashboard` as Route} style={{ color: "inherit" }}>
            Project workspace
          </Link>
        </MenuItem>
      )}
      {isSuperAdmin && (
        <MenuItem icon="shield">
          <Link href={"/admin/dashboard" as Route} style={{ color: "inherit" }}>
            Super Admin
          </Link>
        </MenuItem>
      )}
    </Menu>
  );
}
