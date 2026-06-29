import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectEnvironmentsClient } from "./ProjectEnvironmentsClient";

export const metadata = { title: "Environments · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/environments`);
  return <ProjectEnvironmentsClient slug={projectSlug} />;
}
