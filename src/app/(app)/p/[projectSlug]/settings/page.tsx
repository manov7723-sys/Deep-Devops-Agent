import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectSettingsClient } from "./ProjectSettingsClient";

export const metadata = { title: "Settings · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  const { project } = await requireProjectPage(projectSlug, `/p/${projectSlug}/settings`);
  return <ProjectSettingsClient slug={projectSlug} projectName={project.name} />;
}
