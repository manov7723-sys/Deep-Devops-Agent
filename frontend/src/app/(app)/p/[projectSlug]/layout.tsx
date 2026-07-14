import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { requireProjectAccess } from "@/lib/projects/permissions";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const gate = await requireProjectAccess(projectSlug, "viewer");
  if (!gate.ok) {
    if (gate.status === 401) redirect("/auth/login");
    notFound(); // 404 covers both "no such project" and "not a member"
  }
  const { session } = gate.access;
  return (
    <AppShell
      area="project"
      projectSlug={projectSlug}
      me={{
        name: session.user.name,
        email: session.user.email,
        isSuperAdmin: session.user.isSuperAdmin,
      }}
    >
      {children}
    </AppShell>
  );
}
