import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono, Manrope, Hanken_Grotesk } from "next/font/google";
import { preinit } from "react-dom";
import { Providers } from "@/components/providers/Providers";
import "@/styles/globals.css";

const ui = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-ui-loaded",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono-loaded",
  display: "swap",
});

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  display: "swap",
});

const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-hanken",
  display: "swap",
});

export const metadata: Metadata = {
  title: "DeepAgent DevOps",
  description: "Connect GitHub, choose repos, ship to your cloud — with agents.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#1b1b24" },
    { media: "(prefers-color-scheme: light)", color: "#fbfafc" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // React 19's preinit() is the supported way to inject a script from a
  // Server Component. It hoists into <head> via React's resource system —
  // NOT as a React <script> child — so the DEV-only "Encountered a script
  // tag while rendering React component" warning doesn't fire.
  //
  // Rendering the script as JSX (inline, `<script src>`, or wrapped in
  // next/script) all trip that warning in React 19: the check runs on every
  // <script> fiber regardless of props, and there is no JSX shape that
  // opts out. preinit() is the escape hatch.
  //
  // The script sets data-theme + CSS vars from localStorage before paint;
  // `data-theme="dark"` on <html> below is the SSR default users see if
  // the browser blocks the script or JS is disabled.
  preinit("/theme-init.js", { as: "script" });

  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${ui.variable} ${mono.variable} ${manrope.variable} ${hanken.variable}`}
      suppressHydrationWarning
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
