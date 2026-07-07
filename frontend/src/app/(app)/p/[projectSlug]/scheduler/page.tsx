import { requireProjectPage } from "@/lib/projects/page-guards";
import { SchedulerClient } from "./SchedulerClient";

export const metadata = { title: "Scheduler · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/scheduler`);
  return <SchedulerClient slug={projectSlug} />;
}
