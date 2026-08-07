import { requireProjectPage } from "@/lib/projects/page-guards";
import { TeamChatClient } from "./TeamChatClient";

export const metadata = { title: "Team chat · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/team-chat`);
  return <TeamChatClient slug={projectSlug} />;
}
