import { requireProjectPage } from "@/lib/projects/page-guards";
import { DeployClient } from "./DeployClient";

export const metadata = { title: "Deploy my app · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/deploy`);
  return <DeployClient slug={projectSlug} />;
}
