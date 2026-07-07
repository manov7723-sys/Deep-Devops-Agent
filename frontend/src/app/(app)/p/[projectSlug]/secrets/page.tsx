import { requireProjectPage } from "@/lib/projects/page-guards";
import { SecretsClient } from "./SecretsClient";

export const metadata = { title: "Secrets · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/secrets`);
  return <SecretsClient slug={projectSlug} />;
}
