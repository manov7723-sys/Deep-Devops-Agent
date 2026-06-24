import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectActivityClient } from "./ProjectActivityClient";

export const metadata = { title: "Activity · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/activity`);
  return <ProjectActivityClient slug={projectSlug} />;
}
