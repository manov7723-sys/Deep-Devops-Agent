"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { Badge, Icon, StatusDot } from "@/components/ui";
import { Logo } from "./Logo";
import { NAV, navHref, type LayoutArea } from "./nav-registry";
import { ProjectSwitcher } from "./ProjectSwitcher";

export interface SidebarProps {
  area: LayoutArea;
  projectSlug?: string;
  /** Optional close handler — only passed by the mobile drawer. */
  onClose?: () => void;
}

export function Sidebar({ area, projectSlug, onClose }: SidebarProps) {
  const pathname = usePathname();
  const entries = NAV[area];

  return (
    <aside className="dda-sidebar col">
      <div className="dda-sidebar-head row between">
        <Logo />
        {onClose && (
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close menu">
            <Icon name="x" size={16} />
          </button>
        )}
      </div>

      {area === "project" && projectSlug && (
        <div style={{ padding: "0 12px 8px" }}>
          <ProjectSwitcher activeSlug={projectSlug} />
        </div>
      )}

      <nav className="col gap-1 dda-sidebar-nav">
        {entries.map((entry, i) => {
          if (entry.kind === "section") {
            return (
              <div key={`sep-${i}`} className="dda-sidebar-sep">
                {entry.label}
              </div>
            );
          }
          const href = navHref(area, entry.hrefSegment, projectSlug) as Route;
          const isActive = pathname === href;
          return (
            <Link
              key={entry.id}
              href={href}
              onClick={onClose}
              className={`row between dda-sidebar-item ${isActive ? "active" : ""}`}
              aria-current={isActive ? "page" : undefined}
            >
              <span className="row gap-3">
                <Icon name={entry.icon} size={17} stroke={isActive ? 2.2 : 2} />
                {entry.label}
              </span>
              {entry.badge && (
                <Badge tone={entry.badge.tone ?? "accent"}>{entry.badge.count}</Badge>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="dda-sidebar-foot">
        <div className="card dda-sidebar-status">
          <div className="row gap-2" style={{ marginBottom: 6 }}>
            <StatusDot tone="ok" pulse />
            <span style={{ fontSize: 12.5, fontWeight: 700 }} className="nowrap">
              Deep Agent · Online
            </span>
          </div>
          <p className="faint" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
            Watching 7 environments · 5 agents active
          </p>
        </div>
      </div>
    </aside>
  );
}
