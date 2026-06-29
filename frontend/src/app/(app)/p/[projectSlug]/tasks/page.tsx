import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectTasksClient } from "./ProjectTasksClient";

export const metadata = { title: "Tasks · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/tasks`);
  return <ProjectTasksClient slug={projectSlug} />;
}
