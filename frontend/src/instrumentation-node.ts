/**
 * Node-runtime-only startup — loaded by instrumentation.ts strictly when
 * NEXT_RUNTIME === "nodejs". Lives in its own file so the Edge bundle never
 * statically sees the node:dns import (Turbopack warns on it otherwise).
 */
import dns from "node:dns";
import { startScheduler } from "@/lib/scheduler/scheduler";

// Prefer IPv4 DNS results for outbound fetches (GitHub/OpenAI/cloud APIs).
// On networks with broken IPv6, Node otherwise tries IPv6 first and stalls
// for ~10s per request or fails outright — which surfaced as bogus
// "repository is empty or no access" errors from the GitHub API.
dns.setDefaultResultOrder("ipv4first");

startScheduler();
