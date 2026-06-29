import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectAlertsClient } from "./ProjectAlertsClient";

export const metadata = { title: "Alerts · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/alerts`);
  return <ProjectAlertsClient slug={projectSlug} />;
}
