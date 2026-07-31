import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProvisionedInfraClient } from "./ProvisionedInfraClient";

export const metadata = { title: "Provisioned · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/provisioned`);
  return <ProvisionedInfraClient slug={projectSlug} />;
}
