import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectChatClient } from "./ProjectChatClient";

export const metadata = { title: "Chat · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/chat`);
  return <ProjectChatClient slug={projectSlug} />;
}
