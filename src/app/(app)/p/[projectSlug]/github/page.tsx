import { requireProjectPage } from "@/lib/projects/page-guards";
import { GithubConnectionClient } from "./GithubConnectionClient";

export const metadata = { title: "GitHub · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/github`);
  return <GithubConnectionClient slug={projectSlug} />;
}
