import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectConnectionClient } from "./ConnectionClient";

export const metadata = { title: "Connection · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/connection`);
  return <ProjectConnectionClient slug={projectSlug} />;
}
