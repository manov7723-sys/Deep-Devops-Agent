import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  // cacheComponents: true,  // Re-enable in Phase 10 with proper Suspense boundaries
  typedRoutes: true,
  // argon2 ships a native .node binding; don't bundle, load via Node at runtime.
  // @prisma/client + @prisma/engines must also be external for the same reason.
  serverExternalPackages: ["argon2", "@prisma/client", "@prisma/engines"],
};

export default nextConfig;
