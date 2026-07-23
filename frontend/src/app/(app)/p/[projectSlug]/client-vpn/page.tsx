import { requireProjectPage } from "@/lib/projects/page-guards";
import { ProjectClientVpnClient } from "./ProjectClientVpnClient";

export const metadata = { title: "Client VPN · DeepAgent" };

export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  await requireProjectPage(projectSlug, `/p/${projectSlug}/client-vpn`);
  return <ProjectClientVpnClient slug={projectSlug} />;
}
