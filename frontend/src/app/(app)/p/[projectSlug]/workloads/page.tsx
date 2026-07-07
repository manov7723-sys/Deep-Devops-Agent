import { requireProjectPage } from "@/lib/projects/page-guards";
import { WorkloadsClient } from "./WorkloadsClient";

export const metadata = { title: "Workloads · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/workloads`);
  return <WorkloadsClient slug={projectSlug} />;
}
