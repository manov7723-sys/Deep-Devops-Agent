"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "./Icon";

export type BtnVariant = "primary" | "ghost" | "outline" | "danger" | "default";
export type BtnSize = "sm" | "md" | "lg" | "icon";

export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: BtnSize;
  icon?: IconName;
  iconRight?: IconName;
  block?: boolean;
  loading?: boolean;
}

const variantClass: Record<BtnVariant, string> = {
  default: "",
  primary: "primary",
  ghost: "ghost",
  outline: "outline",
  danger: "danger",
};

const sizeClass: Record<BtnSize, string> = {
  sm: "sm",
  md: "",
  lg: "lg",
  icon: "icon",
};

export const Btn = forwardRef<HTMLButtonElement, BtnProps>(function Btn(
  {
    variant = "default",
    size = "md",
    icon,
    iconRight,
    block,
    loading,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  const iconSize = size === "sm" ? 14 : 16;
  return (
    <button
      ref={ref}
      className={cn("btn", variantClass[variant], sizeClass[size], block && "block", className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <Icon name="refresh" size={iconSize} className="spin" />
      ) : (
        <>
          {icon && <Icon name={icon} size={iconSize} />}
          {/*
            Render children when:
              - normal (non-icon) button — children are the label
              - icon-sized button with no `icon` prop — children carry the icon
            But NOT when both `size="icon"` AND `icon` prop are set, otherwise
            we'd render the icon twice.
          */}
          {(size !== "icon" || !icon) && children}
        </>
      )}
      {!loading && iconRight && size !== "icon" && <Icon name={iconRight} size={iconSize} />}
    </button>
  );
});
