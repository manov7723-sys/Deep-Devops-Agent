/**
 * Node-runtime-only startup — loaded by instrumentation.ts strictly when
 * NEXT_RUNTIME === "nodejs". Lives in its own file so the Edge bundle never
 * statically sees the node:dns import (Turbopack warns on it otherwise).
 */
import dns from "node:dns";
import { startScheduler } from "@/lib/scheduler/scheduler";
import { startPipelineSweeper } from "@/lib/ci/pipeline-sweeper";

// Prefer IPv4 DNS results for outbound fetches (GitHub/OpenAI/cloud APIs).
// On networks with broken IPv6, Node otherwise tries IPv6 first and stalls
// for ~10s per request or fails outright — which surfaced as bogus
// "repository is empty or no access" errors from the GitHub API.
dns.setDefaultResultOrder("ipv4first");

startScheduler();

// CI/CD review agent: sweeps every pipeline's GitHub runs on an interval and
// arms watchers/heals for runs the app didn't start itself (client pushes,
// github.com re-runs, workflow_run chains, runs from before a restart).
startPipelineSweeper();
