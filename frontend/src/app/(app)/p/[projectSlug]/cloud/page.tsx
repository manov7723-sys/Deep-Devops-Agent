import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectCloudClient } from "./ProjectCloudClient";

export const metadata = { title: "Cloud · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/cloud`);
  return <ProjectCloudClient slug={projectSlug} />;
}
