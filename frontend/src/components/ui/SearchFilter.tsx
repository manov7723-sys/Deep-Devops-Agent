"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "./Icon";

export interface SearchFilterProps {
  /** Search-box placeholder. */
  placeholder?: string;
  /** URL param name. Defaults to `q`. */
  param?: string;
  /** When set, the component is controlled and does NOT touch the URL. */
  value?: string;
  onChange?: (v: string) => void;
  /** Override the container width. */
  width?: number | string;
}

/**
 * Text input bound to `?q=` (or a custom param). Debounced 200ms before
 * pushing the new URL so typing doesn't flood the history stack.
 */
export function SearchFilter({
  placeholder = "Search…",
  param = "q",
  value,
  onChange,
  width = 280,
}: SearchFilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const fromUrl = sp.get(param) ?? "";

  const [local, setLocal] = useState(value ?? fromUrl);

  // Sync down if URL is changed externally (back/forward).
  useEffect(() => {
    if (value === undefined) setLocal(fromUrl);
  }, [value, fromUrl]);

  const push = useCallback(
    (next: string) => {
      if (onChange) {
        onChange(next);
        return;
      }
      const params = new URLSearchParams(sp);
      if (next) params.set(param, next);
      else params.delete(param);
      const q = params.toString();
      router.replace((q ? `${pathname}?${q}` : pathname) as Route);
    },
    [onChange, sp, param, router, pathname],
  );

  useEffect(() => {
    if (value !== undefined) return;
    const handle = setTimeout(() => {
      if (local !== fromUrl) push(local);
    }, 200);
    return () => clearTimeout(handle);
  }, [local, fromUrl, value, push]);

  const effective = value ?? local;

  return (
    <div
      className="row gap-2 dda-search-input"
      style={{ width }}
    >
      <Icon name="search" size={15} />
      <input
        value={effective}
        onChange={(e) => {
          if (value !== undefined) onChange?.(e.target.value);
          setLocal(e.target.value);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  );
}
