import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectCicdClient } from "./ProjectCicdClient";

export const metadata = { title: "Cicd · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/cicd`);
  return <ProjectCicdClient slug={projectSlug} />;
}
