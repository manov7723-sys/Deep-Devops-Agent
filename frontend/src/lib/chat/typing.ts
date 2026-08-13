/**
 * In-memory typing-indicator store.
 *
 * Not persistent, not shared across instances — the whole point is that a
 * "typing" signal has a lifespan of ~seconds, so a DB or Redis round-trip on
 * every keystroke is wasted work. Clients POST when they start typing and
 * every N seconds while composing; entries auto-expire after IDLE_MS so a
 * caller that closes their tab mid-compose doesn't leave a ghost.
 *
 * Trade-off: on a multi-instance deploy, each node's typing set only knows
 * about users connected to it — a user typing on instance A won't show as
 * typing to a viewer on instance B. Acceptable for a demo-scale rollout; a
 * production one can swap this out for Redis or SSE fan-out.
 */

const IDLE_MS = 6_000;

type Entry = { userId: string; userName: string; at: number };

// Keyed by projectId — one map per project, one entry per typing user.
const typingByProject = new Map<string, Map<string, Entry>>();

/**
 * Record a typing heartbeat. Call this from the /typing POST handler when a
 * user is composing, and set `stop:true` to remove them (e.g. when they hit
 * send or explicitly clear the input).
 */
export function recordTypingActivity(args: {
  projectId: string;
  userId: string;
  userName: string;
  stop?: boolean;
}): void {
  let byUser = typingByProject.get(args.projectId);
  if (!byUser) {
    if (args.stop) return;
    byUser = new Map();
    typingByProject.set(args.projectId, byUser);
  }
  if (args.stop) {
    byUser.delete(args.userId);
    if (byUser.size === 0) typingByProject.delete(args.projectId);
    return;
  }
  byUser.set(args.userId, {
    userId: args.userId,
    userName: args.userName,
    at: Date.now(),
  });
}

/**
 * Snapshot the currently-typing users for a project, EXCLUDING the caller
 * (the UI never renders "you are typing"). Expired entries are pruned
 * inline — every read is a lazy GC pass so no separate timer is needed.
 */
export function listTypingUsers(args: {
  projectId: string;
  excludeUserId: string;
}): Array<{ userId: string; userName: string }> {
  const byUser = typingByProject.get(args.projectId);
  if (!byUser) return [];
  const now = Date.now();
  const alive: Array<{ userId: string; userName: string }> = [];
  for (const [userId, entry] of byUser) {
    if (now - entry.at > IDLE_MS) {
      byUser.delete(userId);
      continue;
    }
    if (userId === args.excludeUserId) continue;
    alive.push({ userId: entry.userId, userName: entry.userName });
  }
  if (byUser.size === 0) typingByProject.delete(args.projectId);
  return alive;
}
