import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export interface EmptyProps {
  icon?: IconName;
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function Empty({
  icon = "box",
  title = "Nothing here yet",
  description,
  action,
}: EmptyProps) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <span className="empty-title">{title}</span>
      {description && <span className="empty-sub">{description}</span>}
      {action}
    </div>
  );
}
