import { requireProjectPage } from "@/lib/projects/page-guards";
import { EnvViewerClient } from "./EnvViewerClient";

export const metadata = { title: "Env viewer · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/env-viewer`);
  return <EnvViewerClient slug={projectSlug} />;
}
