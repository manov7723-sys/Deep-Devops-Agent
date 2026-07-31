import { requireProjectPage } from "@/lib/projects/page-guards";
import { ReportsClient } from "./ReportsClient";

export const metadata = { title: "Reports · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/reports`);
  return <ReportsClient slug={projectSlug} />;
}
