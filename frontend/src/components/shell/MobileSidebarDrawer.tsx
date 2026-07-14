"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Btn, Icon } from "@/components/ui";
import { Sidebar } from "./Sidebar";
import type { LayoutArea } from "./nav-registry";

export interface MobileSidebarDrawerProps {
  area: LayoutArea;
  projectSlug?: string;
}

export function MobileSidebarDrawer({ area, projectSlug }: MobileSidebarDrawerProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Btn variant="ghost" size="icon" className="dda-mob-menu-floating" aria-label="Open menu">
          <Icon name="menu" size={18} />
        </Btn>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" style={{ zIndex: 150 }} />
        <Dialog.Content className="dda-mobile-drawer">
          <Dialog.Title style={{ position: "absolute", left: -9999 }}>Navigation</Dialog.Title>
          <Sidebar area={area} projectSlug={projectSlug} onClose={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
