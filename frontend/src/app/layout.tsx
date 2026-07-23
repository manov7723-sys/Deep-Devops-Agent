import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono, Manrope, Hanken_Grotesk } from "next/font/google";
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
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${ui.variable} ${mono.variable} ${manrope.variable} ${hanken.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Pre-hydration theme initializer. Served as a real static file from
            /public/theme-init.js — an EXTERNAL script React 19 hoists as-is
            without the "Encountered a script tag while rendering React
            component" dev warning that fires on ANY inline <script> in JSX.
            Same-origin, browser-cached; blocks first paint just like the old
            inline version so there's no FOUC. See public/theme-init.js. */}
        <script src="/theme-init.js" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
