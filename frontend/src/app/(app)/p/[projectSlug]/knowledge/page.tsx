import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectKnowledgeClient } from "./ProjectKnowledgeClient";

export const metadata = { title: "Knowledge · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/knowledge`);
  return <ProjectKnowledgeClient slug={projectSlug} />;
}
