"use client";

import { Badge, Icon, Menu, MenuLabel, MenuSeparator } from "@/components/ui";
import { useNotifications } from "@/hooks/queries/notifications";
import type { IconName } from "@/components/ui";

export function NotificationsDropdown() {
  const { data } = useNotifications();
  const items = data ?? [];
  const unread = items.filter((n) => n.unread).length;

  return (
    <Menu
      width={320}
      align="end"
      trigger={
        <button
          className="btn ghost icon"
          aria-label="Notifications"
          style={{ position: "relative" }}
        >
          <Icon name="bell" size={18} />
          {unread > 0 && (
            <span
              className="dot danger"
              style={{ position: "absolute", top: 8, right: 9, width: 7, height: 7 }}
            />
          )}
        </button>
      }
    >
      <div className="row between" style={{ padding: "6px 10px" }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>Notifications</span>
        <Badge tone="accent">{unread} new</Badge>
      </div>
      <MenuSeparator />
      {items.length === 0 ? (
        <p className="muted" style={{ padding: 10, fontSize: 12.5 }}>
          You're all caught up.
        </p>
      ) : (
        items.map((n) => (
          <div key={n.id} className="row gap-3 dda-notif-row">
            <span className="dda-notif-icon">
              <Icon name={(n.icon as IconName) ?? "bell"} size={15} />
            </span>
            <div className="col" style={{ lineHeight: 1.3 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{n.title}</span>
              <span className="faint" style={{ fontSize: 11.5 }}>
                {n.subtitle}
              </span>
            </div>
          </div>
        ))
      )}
      <MenuSeparator />
      <MenuLabel>Mark all read · View all (Phase 7)</MenuLabel>
    </Menu>
  );
}
