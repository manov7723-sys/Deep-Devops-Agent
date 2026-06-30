import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectDashboardClient } from "./ProjectDashboardClient";

export const metadata = { title: "Dashboard · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  const { project } = await requireProjectPage(projectSlug, `/p/${projectSlug}/dashboard`);
  return <ProjectDashboardClient slug={projectSlug} projectName={project.name} />;
}
