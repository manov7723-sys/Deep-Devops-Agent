/**
 * Extract IP + UA from a request so Session rows have provenance for the
 * "Review devices" surface (Phase 3) and audit logs.
 */
export function extractRequestMeta(req: Request): { ipAddress: string | null; userAgent: string | null } {
  const xff = req.headers.get("x-forwarded-for");
  const ipAddress = xff
    ? xff.split(",")[0]!.trim()
    : req.headers.get("x-real-ip") ?? null;
  const userAgent = req.headers.get("user-agent");
  return { ipAddress, userAgent };
}
