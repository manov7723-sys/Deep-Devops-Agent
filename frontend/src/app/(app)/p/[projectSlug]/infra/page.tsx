import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectInfraClient } from "./InfraClient";

export const metadata = { title: "Infrastructure · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/infra`);
  return <ProjectInfraClient slug={projectSlug} />;
}
