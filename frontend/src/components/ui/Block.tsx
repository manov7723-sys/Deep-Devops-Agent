/**
 * Block — slotted composition primitive used on every logged-in screen.
 *
 * Slots: Header (Title + Actions), Toolbar, Body (padded scroll), Empty, Loading, Error.
 *
 * Each slot is a child component on `Block`. Consumers compose only what they need:
 *
 *   <Block>
 *     <Block.Header>
 *       <Block.Title>Recent pipelines</Block.Title>
 *       <Block.Actions><Btn size="sm" variant="ghost">View all</Btn></Block.Actions>
 *     </Block.Header>
 *     <Block.Toolbar><EnvFilter ... /></Block.Toolbar>
 *     <Block.Body>...rows...</Block.Body>
 *   </Block>
 *
 * Or the explicit state slots when the body is async:
 *   <Block>
 *     <Block.Header><Block.Title>Approvals</Block.Title></Block.Header>
 *     {isLoading ? <Block.Loading /> : err ? <Block.Error /> : items.length ? <Block.Body>...</Block.Body> : <Block.Empty />}
 *   </Block>
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Empty, type EmptyProps } from "./Empty";

export interface BlockProps {
  children: ReactNode;
  className?: string;
  /**
   * Cap the card's max width. Pages used to wrap `<Block>` in ad-hoc
   * `<div style={{maxWidth: N}}>` at five different widths — settings 720/760,
   * connection 480/520, form panels 680 — producing visually inconsistent
   * sections. Set `maxWidth` here for a single source of truth per page.
   * Examples: 480 (compact form panel), 720 (settings form), unset (full width).
   */
  maxWidth?: number;
}

function BlockRoot({ children, className, maxWidth }: BlockProps) {
  return (
    <section
      className={cn("card", className)}
      style={maxWidth ? { maxWidth, width: "100%" } : undefined}
    >
      {children}
    </section>
  );
}

function Header({ children }: { children: ReactNode }) {
  return <div className="card-h">{children}</div>;
}

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="col" style={{ gap: 2 }}>
      <span className="card-title">{children}</span>
      {sub && (
        <span className="faint" style={{ fontSize: 12 }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="row gap-2" style={{ marginLeft: "auto" }}>
      {children}
    </div>
  );
}

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="card-toolbar">{children}</div>;
}

function Body({
  children,
  padded = true,
  scroll = false,
  className,
}: {
  children: ReactNode;
  padded?: boolean;
  scroll?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(padded && "card-pad", className)}
      style={scroll ? { maxHeight: 480, overflowY: "auto" } : undefined}
    >
      {children}
    </div>
  );
}

function BlockEmpty(props: EmptyProps) {
  return (
    <div className="card-pad">
      <Empty {...props} />
    </div>
  );
}

function Loading() {
  return (
    <div className="card-pad col gap-3">
      <span className="skel" style={{ height: 14, width: "60%" }} />
      <span className="skel" style={{ height: 14, width: "40%" }} />
      <span className="skel" style={{ height: 14, width: "75%" }} />
    </div>
  );
}

function ErrorState({
  message = "Something went wrong.",
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="card-pad">
      <Empty
        icon="alert"
        title="Could not load"
        description={message}
        action={
          onRetry ? (
            <button type="button" className="btn outline sm" onClick={onRetry}>
              Retry
            </button>
          ) : undefined
        }
      />
    </div>
  );
}

/**
 * Convenience helper for the common pattern of:
 *   if (isError) <Block.Error /> else if (data) ...children... else <Block.Loading />
 */
function Async<T>({
  data,
  isError,
  error,
  onRetry,
  children,
}: {
  data: T | undefined;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  children: (data: T) => ReactNode;
}) {
  if (isError) {
    const message =
      (error as { message?: string } | undefined)?.message ?? "Mock returned an error.";
    return <ErrorState message={message} onRetry={onRetry} />;
  }
  if (!data) return <Loading />;
  return <>{children(data)}</>;
}

export const Block = Object.assign(BlockRoot, {
  Header,
  Title,
  Actions,
  Toolbar,
  Body,
  Empty: BlockEmpty,
  Loading,
  Error: ErrorState,
  Async,
});
