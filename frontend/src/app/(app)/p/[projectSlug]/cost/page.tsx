import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectCostClient } from "./ProjectCostClient";

export const metadata = { title: "Cost · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/cost`);
  return <ProjectCostClient slug={projectSlug} />;
}
