import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui";

export interface SecurityRowProps {
  icon: IconName;
  title: ReactNode;
  description: ReactNode;
  action: ReactNode;
}

export function SecurityRow({ icon, title, description, action }: SecurityRowProps) {
  return (
    <div className="row between gap-3 dda-security-row">
      <div className="row gap-3" style={{ minWidth: 0 }}>
        <span className="row center dda-security-icon">
          <Icon name={icon} size={17} />
        </span>
        <div className="col" style={{ lineHeight: 1.35, minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{title}</span>
          <span className="faint" style={{ fontSize: 12 }}>
            {description}
          </span>
        </div>
      </div>
      {action}
    </div>
  );
}
