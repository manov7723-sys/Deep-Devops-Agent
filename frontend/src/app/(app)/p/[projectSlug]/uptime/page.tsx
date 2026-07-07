import { requireProjectPage } from "@/lib/projects/page-guards";
import { UptimeClient } from "./UptimeClient";

export const metadata = { title: "Uptime · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/uptime`);
  return <UptimeClient slug={projectSlug} />;
}
