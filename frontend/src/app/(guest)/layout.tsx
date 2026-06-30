import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default async function GuestLayout({ children }: { children: React.ReactNode }) {
  const sess = await getSession();
  if (sess) redirect("/u/dashboard");
  return <>{children}</>;
}
