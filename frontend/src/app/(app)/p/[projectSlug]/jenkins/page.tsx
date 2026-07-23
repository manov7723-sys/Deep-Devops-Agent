import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectJenkinsClient } from "./ProjectJenkinsClient";

export const metadata = { title: "Jenkins · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/jenkins`);
  return <ProjectJenkinsClient slug={projectSlug} />;
}
