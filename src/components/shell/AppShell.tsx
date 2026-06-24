"use client";

import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileSidebarDrawer } from "./MobileSidebarDrawer";
import { ChaosBanner } from "./ChaosBanner";
import type { LayoutArea } from "./nav-registry";

export interface AppShellProps {
  area: LayoutArea;
  projectSlug?: string;
  me: { name: string; email: string; isSuperAdmin: boolean };
  children: React.ReactNode;
}

/**
 * Phase 2 — three areas (user / admin / project) share this shell:
 *   [desktop sidebar 248px] [topbar + scrollable main, max-width 1280px]
 * Below 900px, the sidebar collapses into a Radix Dialog drawer.
 */
export function AppShell({ area, projectSlug, me, children }: AppShellProps) {
  const [, setDrawerKey] = useState(0); // placeholder for future drawer state hoisting

  return (
    <div className="dda-shell row">
      <div className="dda-sidebar-desktop">
        <Sidebar area={area} projectSlug={projectSlug} />
      </div>
      <div className="col grow" style={{ minWidth: 0 }}>
        <Topbar area={area} me={me} onMenuClick={() => setDrawerKey((k) => k + 1)} />
        <MobileSidebarDrawer area={area} projectSlug={projectSlug} />
        <ChaosBanner />
        <main className="dda-main grow">
          <div className="dda-page-wrap">{children}</div>
        </main>
      </div>
    </div>
  );
}
