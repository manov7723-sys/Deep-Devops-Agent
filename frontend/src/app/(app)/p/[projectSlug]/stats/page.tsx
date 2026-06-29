import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectStatsClient } from "./ProjectStatsClient";

export const metadata = { title: "Stats · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/stats`);
  return <ProjectStatsClient slug={projectSlug} />;
}
