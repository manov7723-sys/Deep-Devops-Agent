import type { IconName } from "@/components/ui";
import type { Tone } from "@/lib/api/schemas";

export type LayoutArea = "user" | "admin" | "project";

export type NavEntry =
  | {
      kind: "link";
      id: string;
      label: string;
      icon: IconName;
      hrefSegment: string;
      badge?: { count: number; tone?: Tone };
    }
  | { kind: "section"; label: string };

export const NAV: Record<LayoutArea, NavEntry[]> = {
  user: [
    {
      kind: "link",
      id: "dashboard",
      label: "Dashboard",
      icon: "dashboard",
      hrefSegment: "dashboard",
    },
    { kind: "link", id: "projects", label: "Projects", icon: "projects", hrefSegment: "projects" },
    { kind: "link", id: "teams", label: "Teams", icon: "teams", hrefSegment: "teams" },
    {
      kind: "link",
      id: "subscription",
      label: "Subscription",
      icon: "card",
      hrefSegment: "subscription",
    },
    { kind: "link", id: "usage", label: "Usage", icon: "gauge", hrefSegment: "usage" },
    { kind: "link", id: "settings", label: "Settings", icon: "settings", hrefSegment: "settings" },
  ],
  admin: [
    {
      kind: "link",
      id: "dashboard",
      label: "Dashboard",
      icon: "dashboard",
      hrefSegment: "dashboard",
    },
    { kind: "link", id: "users", label: "Users", icon: "users", hrefSegment: "users" },
    { kind: "link", id: "plans", label: "Plans", icon: "plan", hrefSegment: "plans" },
    {
      kind: "link",
      id: "subscriptions",
      label: "Subscriptions",
      icon: "card",
      hrefSegment: "subscriptions",
    },
    { kind: "link", id: "addons", label: "Add-on purchases", icon: "addon", hrefSegment: "addons" },
    { kind: "link", id: "billing", label: "Billing", icon: "receipt", hrefSegment: "billing" },
    { kind: "section", label: "Platform" },
    { kind: "link", id: "mcp", label: "MCP servers", icon: "server", hrefSegment: "mcp" },
    { kind: "link", id: "agents", label: "Agents", icon: "bot", hrefSegment: "agents" },
    { kind: "link", id: "models", label: "Models", icon: "model", hrefSegment: "models" },
    { kind: "link", id: "settings", label: "Settings", icon: "settings", hrefSegment: "settings" },
  ],
  project: [
    {
      kind: "link",
      id: "dashboard",
      label: "Dashboard",
      icon: "dashboard",
      hrefSegment: "dashboard",
    },
    { kind: "link", id: "chat", label: "Chat", icon: "chat", hrefSegment: "chat" },
    { kind: "link", id: "cicd", label: "CI/CD & Repos", icon: "cicd", hrefSegment: "cicd" },
    {
      kind: "link",
      id: "environments",
      label: "Environments",
      icon: "layers",
      hrefSegment: "environments",
    },
    { kind: "link", id: "cloud", label: "Cloud providers", icon: "cloud", hrefSegment: "cloud" },
    { kind: "link", id: "infra", label: "Infrastructure", icon: "server", hrefSegment: "infra" },
    { kind: "link", id: "network", label: "Network", icon: "link", hrefSegment: "network" },
    { kind: "link", id: "connections", label: "Connections", icon: "link", hrefSegment: "connections" },
    { kind: "link", id: "client-vpn", label: "Client VPN", icon: "download", hrefSegment: "client-vpn" },
    { kind: "link", id: "jenkins", label: "Jenkins", icon: "cicd", hrefSegment: "jenkins" },
    { kind: "link", id: "topology", label: "Topology", icon: "link", hrefSegment: "topology" },
    { kind: "section", label: "Deploy" },
    {
      kind: "link",
      id: "promotions",
      label: "Promotions",
      icon: "branch",
      hrefSegment: "promotions",
    },
    { kind: "section", label: "Connection" },
    { kind: "link", id: "github", label: "Source control", icon: "github", hrefSegment: "github" },
    { kind: "link", id: "connection", label: "Clusters", icon: "globe", hrefSegment: "connection" },
    { kind: "link", id: "stats", label: "Cloud stats", icon: "stats", hrefSegment: "stats" },
    { kind: "link", id: "uptime", label: "Uptime", icon: "gauge", hrefSegment: "uptime" },
    { kind: "link", id: "scheduler", label: "Scheduler", icon: "clock", hrefSegment: "scheduler" },
    { kind: "link", id: "cost", label: "Cost", icon: "dollar", hrefSegment: "cost" },
    { kind: "link", id: "tasks", label: "Tasks", icon: "tasks", hrefSegment: "tasks" },
    {
      kind: "link",
      id: "knowledge",
      label: "Knowledge base",
      icon: "book",
      hrefSegment: "knowledge",
    },
    {
      kind: "link",
      id: "approvals",
      label: "Approvals",
      icon: "approve",
      hrefSegment: "approvals",
      badge: { count: 4, tone: "accent" },
    },
    {
      kind: "link",
      id: "alerts",
      label: "Alerts",
      icon: "alert",
      hrefSegment: "alerts",
      badge: { count: 4, tone: "danger" },
    },
    { kind: "link", id: "activity", label: "Activity", icon: "activity", hrefSegment: "activity" },
    { kind: "link", id: "settings", label: "Settings", icon: "settings", hrefSegment: "settings" },
  ],
};

export const AREA_META: Record<LayoutArea, { label: string; icon: IconName; basePath: string }> = {
  user: { label: "My Account", icon: "user", basePath: "/u" },
  admin: { label: "Super Admin", icon: "shield", basePath: "/admin" },
  project: { label: "Project workspace", icon: "box", basePath: "/p" },
};

/**
 * Build the full href for a nav entry given the layout area and an optional
 * project slug (project-layout only).
 */
export function navHref(area: LayoutArea, segment: string, projectSlug?: string): string {
  if (area === "project") return `/p/${projectSlug}/${segment}`;
  return `${AREA_META[area].basePath}/${segment}`;
}

/**
 * Parse the area + active segment from a pathname like
 *   /u/dashboard | /admin/users | /p/northwind-api/cicd
 */
export function parseAppRoute(pathname: string): {
  area: LayoutArea | null;
  segment: string | null;
  projectSlug: string | null;
} {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "u") return { area: "user", segment: parts[1] ?? null, projectSlug: null };
  if (parts[0] === "admin") return { area: "admin", segment: parts[1] ?? null, projectSlug: null };
  if (parts[0] === "p") {
    return {
      area: "project",
      projectSlug: parts[1] ?? null,
      segment: parts[2] ?? null,
    };
  }
  return { area: null, segment: null, projectSlug: null };
}
