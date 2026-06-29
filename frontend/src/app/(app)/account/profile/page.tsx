import { redirect } from "next/navigation";
import { getActiveSession } from "@/lib/auth/session";
import { ProfileClient } from "./ProfileClient";

export const metadata = { title: "Profile · DeepAgent" };

export default async function Page() {
  const sess = await getActiveSession();
  if (!sess) redirect("/auth/login");
  return <ProfileClient name={sess.user.name} email={sess.user.email} isSuperAdmin={sess.user.isSuperAdmin} />;
}
