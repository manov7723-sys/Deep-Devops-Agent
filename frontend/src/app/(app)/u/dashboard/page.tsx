import { redirect } from "next/navigation";
import { getActiveSession } from "@/lib/auth/session";
import { UserDashboardClient } from "./UserDashboardClient";

export const metadata = { title: "Dashboard · DeepAgent" };

export default async function UserDashboardPage() {
  const sess = await getActiveSession();
  if (!sess) redirect("/auth/login");
  return <UserDashboardClient firstName={sess.user.name.split(" ")[0] ?? sess.user.name} />;
}
