import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectConnectionsClient } from "./ProjectConnectionsClient";

export const metadata = { title: "Connections · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/connections`);
  return <ProjectConnectionsClient slug={projectSlug} />;
}
