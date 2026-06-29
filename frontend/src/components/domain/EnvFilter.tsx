"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { Route } from "next";
import { useCallback } from "react";
import type { EnvId } from "@/lib/legacy-types";

export type EnvFilterValue = "all" | EnvId;

const ITEMS: Array<{ id: EnvFilterValue; label: string; toneClass: string }> = [
  { id: "all", label: "All envs", toneClass: "" },
  { id: "alpha", label: "Alpha", toneClass: "info" },
  { id: "beta", label: "Beta", toneClass: "warn" },
  { id: "release", label: "Release", toneClass: "ok" },
];

export interface EnvFilterProps {
  /** When provided, the filter is controlled and does NOT touch the URL. */
  value?: EnvFilterValue;
  onChange?: (v: EnvFilterValue) => void;
  /** URL param name — defaults to "env". 10 project screens reuse this. */
  param?: string;
}

/**
 * 4-pill env selector. Defaults to URL-driven state via ?env= so a filter
 * is shareable + back/forward-able (DECISIONS.md state rule).
 *
 * Pass `value` + `onChange` to use it in controlled mode (e.g. inside modals).
 */
export function EnvFilter({ value, onChange, param = "env" }: EnvFilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const urlValue = ((sp.get(param) as EnvFilterValue | null) ?? "all");

  const current = value ?? urlValue;

  const setValue = useCallback(
    (next: EnvFilterValue) => {
      if (onChange) {
        onChange(next);
        return;
      }
      const params = new URLSearchParams(sp);
      if (next === "all") params.delete(param);
      else params.set(param, next);
      const q = params.toString();
      router.replace((q ? `${pathname}?${q}` : pathname) as Route);
    },
    [onChange, sp, param, router, pathname],
  );

  return (
    <div className="row gap-2 wrap" role="radiogroup" aria-label="Environment filter">
      {ITEMS.map((it) => {
        const active = current === it.id;
        return (
          <button
            key={it.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setValue(it.id)}
            className={`chip ${active ? "active" : ""}`}
          >
            {it.id !== "all" && (
              <span
                className={`dot ${it.toneClass}`}
                style={{ width: 6, height: 6, boxShadow: "none" }}
              />
            )}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
