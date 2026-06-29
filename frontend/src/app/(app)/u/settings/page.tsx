import { redirect } from "next/navigation";

export const metadata = { title: "Settings · DeepAgent" };

/**
 * The Sidebar's "Settings" entry per DECISIONS.md routes here, then we redirect
 * to the canonical /account/profile surface so account screens live in one place.
 */
export default function Page() {
  redirect("/account/profile");
}
