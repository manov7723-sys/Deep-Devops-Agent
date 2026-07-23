import { redirect } from "next/navigation";

/**
 * The Storage sidebar entry (and its dedicated S3 form page) was removed in
 * favor of the `s3-create` chat wizard. This tiny stub catches anyone still
 * hitting the old `/p/<slug>/storage` URL — bookmarks, browser history,
 * external links — and sends them to the Network page instead of a bare
 * 404. Safe to delete a few releases later once the URL is truly dead.
 */
export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  redirect(`/p/${projectSlug}/network`);
}
