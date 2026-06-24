import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectApprovalsClient } from "./ProjectApprovalsClient";

export const metadata = { title: "Approvals · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/approvals`);
  return <ProjectApprovalsClient slug={projectSlug} />;
}
