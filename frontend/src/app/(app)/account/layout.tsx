import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { getActiveSession } from "@/lib/auth/session";

/**
 * Shared account screens (/account/*). Per DECISIONS.md these always render
 * inside the user shell — the wireframe's "available from any layout" pattern.
 */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const sess = await getActiveSession();
  if (!sess) redirect("/auth/login");
  return (
    <AppShell
      area="user"
      me={{ name: sess.user.name, email: sess.user.email, isSuperAdmin: sess.user.isSuperAdmin }}
    >
      {children}
    </AppShell>
  );
}
