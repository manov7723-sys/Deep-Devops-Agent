import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectNetworkClient } from "./ProjectNetworkClient";

export const metadata = { title: "Network · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/network`);
  return <ProjectNetworkClient slug={projectSlug} />;
}
