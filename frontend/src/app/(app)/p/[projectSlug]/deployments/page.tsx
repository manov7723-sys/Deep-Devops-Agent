import { requireProjectPage } from "@/lib/projects/page-guards";
import { DeploymentsClient } from "./DeploymentsClient";

export const metadata = { title: "Deployments · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/deployments`);
  return <DeploymentsClient slug={projectSlug} />;
}
