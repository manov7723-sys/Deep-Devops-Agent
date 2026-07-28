import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono, Manrope, Hanken_Grotesk } from "next/font/google";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Providers } from "@/components/providers/Providers";
import "@/styles/globals.css";

// Read the pre-hydration theme initializer at module-load time so it can be
// inlined directly into <head> via dangerouslySetInnerHTML. React 19 warns
// about ANY <script> element rendered as a React child (source of the
// "Encountered a script tag while rendering React component" and
// "<html> cannot contain a nested <script>" dev warnings), but does NOT warn
// about dangerouslySetInnerHTML — because it's raw HTML injection, not a
// React child. Reading from /public keeps the source file editable in
// isolation while producing zero extra network requests.
const themeInitScript = readFileSync(
  join(process.cwd(), "public", "theme-init.js"),
  "utf8",
);

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
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${ui.variable} ${mono.variable} ${manrope.variable} ${hanken.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Inline theme init — runs before hydration to avoid FOUC. Using
            dangerouslySetInnerHTML sidesteps React 19's "script tag" warnings.
            Source lives in public/theme-init.js (read at module-load above). */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
