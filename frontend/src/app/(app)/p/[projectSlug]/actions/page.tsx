import { requireProjectPage } from "@/lib/projects/page-guards";
import { GithubActionsClient } from "./GithubActionsClient";

export const metadata = { title: "GitHub Actions · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/actions`);
  return <GithubActionsClient slug={projectSlug} />;
}
