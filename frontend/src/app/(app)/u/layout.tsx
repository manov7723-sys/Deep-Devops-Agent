import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { getActiveSession } from "@/lib/auth/session";

export default async function UserLayout({ children }: { children: React.ReactNode }) {
  const sess = await getActiveSession();
  if (!sess) redirect("/auth/login");
  return (
    <AppShell area="user" me={{ name: sess.user.name, email: sess.user.email, isSuperAdmin: sess.user.isSuperAdmin }}>
      {children}
    </AppShell>
  );
}
