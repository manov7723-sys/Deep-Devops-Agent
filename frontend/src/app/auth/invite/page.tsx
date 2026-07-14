import Link from "next/link";
import { getActiveSession } from "@/lib/auth/session";
import { previewInvitationByToken } from "@/lib/projects/invitations";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { AuthHead } from "@/components/auth/AuthHead";
import { Btn } from "@/components/ui";
import { InviteAcceptClient } from "./InviteAcceptClient";

export const metadata = {
  title: "Accept invitation · DeepAgent",
};

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ token?: string | string[] }>;

export default async function InvitePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const rawToken = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = (rawToken ?? "").trim();

  if (!token) {
    return (
      <AuthFrame>
        <InviteError
          title="Missing invitation token"
          body="This invitation URL is incomplete. Open the link directly from the email you received."
        />
      </AuthFrame>
    );
  }

  const preview = await previewInvitationByToken(token);
  if (!preview) {
    return (
      <AuthFrame>
        <InviteError
          title="Invitation isn't valid"
          body="This link has expired, been used, or was revoked. Ask the inviter to send a new one."
        />
      </AuthFrame>
    );
  }

  const sess = await getActiveSession();
  const nextHref = `/auth/invite?token=${encodeURIComponent(token)}`;

  // Not signed in — surface project details + prompts to sign in / sign up.
  if (!sess) {
    return (
      <AuthFrame>
        <AuthHead
          title={`Join ${preview.projectName}`}
          sub={`${preview.inviterName} invited you as ${preview.role}.`}
        />
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 18 }}>
          Sign in with <b>{preview.invitedEmail}</b> to accept. If you don&apos;t have an account
          yet, create one with the same email and you&apos;ll land back here.
        </p>
        <div className="col gap-3">
          <Link
            href={
              `/auth/login?next=${encodeURIComponent(nextHref)}&email=${encodeURIComponent(preview.invitedEmail)}` as never
            }
            className="btn primary"
          >
            Sign in &amp; accept
          </Link>
          <Link
            href={
              `/auth/signup?next=${encodeURIComponent(nextHref)}&email=${encodeURIComponent(preview.invitedEmail)}` as never
            }
            className="btn outline"
          >
            Create an account
          </Link>
        </div>
        <p className="faint" style={{ fontSize: 12, marginTop: 14 }}>
          Expires {new Date(preview.expiresAt).toLocaleString()}.
        </p>
      </AuthFrame>
    );
  }

  // Signed in as the wrong email — refuse without burning the token.
  if (sess.user.email.toLowerCase() !== preview.invitedEmail.toLowerCase()) {
    return (
      <AuthFrame>
        <AuthHead
          title="Wrong account"
          sub={`This invitation was sent to ${preview.invitedEmail}.`}
        />
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 18 }}>
          You&apos;re currently signed in as <b>{sess.user.email}</b>. Switch accounts and try the
          invitation link again.
        </p>
        <div className="col gap-3">
          <form action="/api/v1/auth/logout" method="POST">
            <Btn type="submit" variant="primary" block>
              Sign out
            </Btn>
          </form>
          <Link href="/u/dashboard" className="btn ghost">
            Go to dashboard
          </Link>
        </div>
      </AuthFrame>
    );
  }

  // Happy path: signed in as the right user — render the accept button.
  return (
    <AuthFrame>
      <AuthHead
        title={`Join ${preview.projectName}`}
        sub={`${preview.inviterName} invited you as ${preview.role}.`}
      />
      <InviteAcceptClient
        token={token}
        projectName={preview.projectName}
        projectSlug={preview.projectSlug}
        role={preview.role}
        expiresAt={preview.expiresAt.toISOString()}
      />
    </AuthFrame>
  );
}

function InviteError({ title, body }: { title: string; body: string }) {
  return (
    <>
      <AuthHead title={title} sub={body} />
      <div className="col gap-3" style={{ marginTop: 12 }}>
        <Link href="/u/dashboard" className="btn primary">
          Go to dashboard
        </Link>
        <Link href="/auth/login" className="btn outline">
          Sign in
        </Link>
      </div>
    </>
  );
}
