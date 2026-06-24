"use client";

import { Icon } from "@/components/ui";

export function TopbarSearch() {
  return (
    <div className="dda-search-box row gap-2">
      <Icon name="search" size={16} />
      <input
        placeholder="Search resources, repos, agents…"
        aria-label="Search"
        style={{
          border: "none",
          background: "transparent",
          outline: "none",
          color: "var(--text)",
          fontSize: 13,
          width: "100%",
          fontFamily: "inherit",
        }}
      />
      <span className="kbd" style={{ flex: "none" }}>⌘K</span>
    </div>
  );
}
