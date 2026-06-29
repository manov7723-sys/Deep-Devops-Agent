import type { ReactNode } from "react";
import { Tabs, type TabItem } from "./Tabs";

export interface PageHeadProps {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  tabs?: TabItem[];
  tabValue?: string;
  onTabChange?: (v: string) => void;
}

/**
 * Top-of-screen header used on every logged-in page.
 * Title + sub on the left, actions on the right, optional Tabs row below.
 */
export function PageHead({ title, sub, actions, tabs, tabValue, onTabChange }: PageHeadProps) {
  return (
    <div className="col gap-4" style={{ marginBottom: 4 }}>
      <div className="row between gap-3 wrap" style={{ alignItems: "flex-start" }}>
        <div className="col" style={{ gap: 4, minWidth: 0 }}>
          <h1 style={{ fontSize: 22, letterSpacing: "-0.02em" }}>{title}</h1>
          {sub && (
            <p className="muted" style={{ fontSize: 13.5 }}>
              {sub}
            </p>
          )}
        </div>
        {actions && <div className="row gap-2 wrap">{actions}</div>}
      </div>
      {tabs && <Tabs items={tabs} value={tabValue} onValueChange={onTabChange} />}
    </div>
  );
}
