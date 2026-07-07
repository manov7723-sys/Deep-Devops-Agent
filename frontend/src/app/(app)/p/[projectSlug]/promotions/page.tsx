import { requireProjectPage } from "@/lib/projects/page-guards";
import { PromotionsClient } from "./PromotionsClient";

export const metadata = { title: "Promotions · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/promotions`);
  return <PromotionsClient slug={projectSlug} />;
}
