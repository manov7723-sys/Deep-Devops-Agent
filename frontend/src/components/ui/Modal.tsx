"use client";

import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { Btn } from "./Btn";
import { Icon } from "./Icon";

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  trigger?: ReactNode;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 520,
  trigger,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className="card modal-content"
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width,
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "calc(100vh - 32px)",
            overflow: "auto",
            boxShadow: "var(--shadow-lg)",
            zIndex: 210,
          }}
        >
          {(title || description) && (
            <div className="card-h">
              <div className="col" style={{ gap: 2 }}>
                {title && (
                  <Dialog.Title asChild>
                    <span className="card-title" style={{ fontSize: 15 }}>
                      {title}
                    </span>
                  </Dialog.Title>
                )}
                {description && (
                  <Dialog.Description asChild>
                    <span className="faint" style={{ fontSize: 12 }}>
                      {description}
                    </span>
                  </Dialog.Description>
                )}
              </div>
              <Dialog.Close asChild>
                <Btn variant="ghost" size="icon" aria-label="Close">
                  <Icon name="x" size={16} />
                </Btn>
              </Dialog.Close>
            </div>
          )}
          <div className="card-pad">{children}</div>
          {footer && (
            <div
              className="card-pad row gap-3"
              style={{ borderTop: "1px solid var(--border-soft)", justifyContent: "flex-end" }}
            >
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
