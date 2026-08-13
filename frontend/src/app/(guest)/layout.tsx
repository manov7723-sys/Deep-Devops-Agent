import { redirect } from "next/navigation";
import { getActiveSession, getPendingSession } from "@/lib/auth/session";

/**
 * Guest layout — hides the login/signup/2FA pages when the visitor is
 * already signed in. But NOT when a login is in progress: session cookies
 * are shared across tabs, so an already-signed-in admin opening a second
 * tab to sign in as another user would previously get bounced off /auth/2fa
 * back to the admin's dashboard before entering the TOTP. When a
 * pending_mfa session exists, we're mid-login and must let the flow finish.
 */
export default async function GuestLayout({ children }: { children: React.ReactNode }) {
  const [active, pending] = await Promise.all([getActiveSession(), getPendingSession()]);
  if (active && !pending) redirect("/u/dashboard");
  return <>{children}</>;
}
