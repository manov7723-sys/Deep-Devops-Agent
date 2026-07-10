import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  // cacheComponents: true,  // Re-enable in Phase 10 with proper Suspense boundaries
  typedRoutes: true,
  // Pin Turbopack's workspace root to THIS folder. Without it, a stray
  // ~/package-lock.json makes Next infer the home directory as the root and
  // scan ~/Downloads — which trips a macOS file-permission crash and emits a
  // "multiple lockfiles" warning. __dirname is the frontend dir (where this
  // config lives), matching the fix Next.js recommends for that warning.
  turbopack: {
    root: __dirname,
  },
  // argon2 ships a native .node binding; don't bundle, load via Node at runtime.
  // @prisma/client + @prisma/engines must also be external for the same reason.
  serverExternalPackages: ["argon2", "@prisma/client", "@prisma/engines"],
};

export default nextConfig;
