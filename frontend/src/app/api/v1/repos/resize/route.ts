import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveSession } from "@/lib/auth/session";
import {
  computeCapacityPlan,
  recommendationsFromCapacity,
  type CapacityPlan,
  type DetectedService,
  type Recommendation,
} from "@/lib/analysis/repo-analyzer";

/**
 * POST /repos/resize
 *
 * Slider handler for the Analysis step. Given the detected services + a new
 * target concurrent-user count, recomputes the CapacityPlan and returns
 * fresh cluster + per-service replicas recommendation rows (same ids as the
 * initial analysis, so the wizard can drop them in place). No GitHub call —
 * pure math over what /repos/analyze already returned. Kept as its own
 * endpoint (not client-side) so the throughput model has one source of
 * truth: any tuning to per-pod RPS lands in one place.
 */
const ServiceInput = z.object({
  name: z.string(),
  path: z.string(),
  stack: z.string(),
  stackTitle: z.string(),
  role: z.enum(["frontend", "backend", "worker", "unknown"]),
  port: z.number().nullable(),
  hasDockerfile: z.boolean(),
});

const Body = z.object({
  services: z.array(ServiceInput).min(1).max(20),
  targetConcurrentUsers: z.number().int().min(10).max(1_000_000),
});

export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const services = parsed.data.services as DetectedService[];
  const capacity: CapacityPlan = computeCapacityPlan(services, parsed.data.targetConcurrentUsers);
  const recommendations: Recommendation[] = recommendationsFromCapacity(services, capacity);
  return NextResponse.json({ ok: true, capacity, recommendations });
}
