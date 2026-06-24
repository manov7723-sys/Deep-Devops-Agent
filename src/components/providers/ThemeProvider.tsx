"use client";

import { useEffect } from "react";
import { useTweaks, applyTweaksToDocument } from "@/store/tweaks";

/**
 * Client-side reconciler. The ThemeScript already set the document attrs
 * before paint; this hook keeps them in sync as the user changes tweaks.
 *
 * Honors a `?theme=` URL override so headless QA can flip themes per request
 * without needing matching localStorage.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme, accent, density, font, hydrated } = useTweaks();
  useEffect(() => {
    if (!hydrated) return;
    const params = new URLSearchParams(window.location.search);
    const urlTheme = params.get("theme");
    const effectiveTheme = urlTheme === "light" || urlTheme === "dark" ? urlTheme : theme;
    applyTweaksToDocument({ theme: effectiveTheme, accent, density, font });
  }, [theme, accent, density, font, hydrated]);
  return <>{children}</>;
}
