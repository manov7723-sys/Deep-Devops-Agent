import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { getActiveSession } from "@/lib/auth/session";

/**
 * Per DECISIONS.md — non-admins get 404 (do not disclose). Middleware also
 * enforces this at the edge; the layout is a belt-and-braces server check.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const sess = await getActiveSession();
  if (!sess) redirect("/auth/login");
  if (!sess.user.isSuperAdmin) notFound();
  return (
    <AppShell area="admin" me={{ name: sess.user.name, email: sess.user.email, isSuperAdmin: true }}>
      {children}
    </AppShell>
  );
}
