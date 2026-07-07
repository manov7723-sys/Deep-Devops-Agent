import { requireProjectPage } from "@/lib/projects/page-guards";
import { TopologyClient } from "./TopologyClient";

export const metadata = { title: "Topology · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/topology`);
  return <TopologyClient slug={projectSlug} />;
}
