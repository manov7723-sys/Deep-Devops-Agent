import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectAutomationClient } from "./AutomationClient";

export const metadata = { title: "Automation · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/automation`);
  return <ProjectAutomationClient slug={projectSlug} />;
}
