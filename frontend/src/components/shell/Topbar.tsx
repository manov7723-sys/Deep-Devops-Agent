"use client";

import { useState } from "react";
import { Btn, Icon } from "@/components/ui";
import { TopbarSearch } from "./TopbarSearch";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { NotificationsDropdown } from "./NotificationsDropdown";
import { UserDropdown } from "./UserDropdown";
import { TweaksPanel } from "./TweaksPanel";
import type { LayoutArea } from "./nav-registry";

export interface TopbarProps {
  area: LayoutArea;
  me: { name: string; email: string; isSuperAdmin: boolean };
  onMenuClick?: () => void;
}

export function Topbar({ area, me, onMenuClick }: TopbarProps) {
  const [tweaksOpen, setTweaksOpen] = useState(false);

  return (
    <>
      <header className="dda-topbar row between">
        <div className="row gap-3">
          <Btn
            variant="ghost"
            size="icon"
            className="dda-mob-menu"
            onClick={onMenuClick}
            aria-label="Open menu"
          >
            <Icon name="menu" size={18} />
          </Btn>
          <TopbarSearch />
        </div>

        <div className="row gap-2">
          <WorkspaceSwitcher area={area} isSuperAdmin={me.isSuperAdmin} />
          <Btn
            variant="ghost"
            size="icon"
            onClick={() => setTweaksOpen(true)}
            aria-label="Appearance"
            title="Appearance"
          >
            <Icon name="sun" size={18} />
          </Btn>
          <NotificationsDropdown />
          <UserDropdown name={me.name} email={me.email} />
        </div>
      </header>
      <TweaksPanel open={tweaksOpen} onOpenChange={setTweaksOpen} />
    </>
  );
}
