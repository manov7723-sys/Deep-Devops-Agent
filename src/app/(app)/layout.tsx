import { redirect } from "next/navigation";
import { getActiveSession } from "@/lib/auth/session";

/**
 * (app) root layout — authenticated surface. Each area (u / admin / p) defines
 * its own nested layout that mounts the AppShell with the right area prop.
 *
 * This layout only verifies the session; the actual shell lives one level deeper
 * so /u, /admin and /p can each compute their own props (projectSlug etc).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const sess = await getActiveSession();
  if (!sess) redirect("/auth/login");
  return <>{children}</>;
}
