import Link from "next/link";
import { Badge, Icon } from "@/components/ui";
import { Logo } from "@/components/shell/Logo";
import { getSession } from "@/lib/auth/session";

const FEATURES = [
  {
    icon: "zap" as const,
    title: "Terraform from a prompt",
    body: "Describe a service. Get a Terraform module with encryption at rest, scoped IAM, tagging — the boring parts done right.",
  },
  {
    icon: "cicd" as const,
    title: "CI/CD per environment",
    body: "Pipelines that map branches to alpha / beta / release. Promotion gates, auto-deploy, one-click retries.",
  },
  {
    icon: "shield" as const,
    title: "Agents that review",
    body: "Drift Watcher, Security Sentinel, Cost Pilot — open PRs, file issues, scan 24/7.",
  },
  {
    icon: "approve" as const,
    title: "Approvals where it matters",
    body: "Risky moves wait for you. See the terraform plan. Approve & apply. Reject and the agent revises.",
  },
];

const STEPS = [
  {
    title: "Connect your code",
    body: "OAuth into GitHub. Pick the repos Deep Agent should read and propose changes against.",
  },
  {
    title: "Wire up your cloud",
    body: "AWS, GCP or Azure. Scoped IAM role — no long-lived keys stored.",
  },
  {
    title: "Describe what to ship",
    body: "“Add an SQS queue for orders.” “Migrate to a read replica.” Deep Agent drafts the Terraform + Helm + the PR.",
  },
  {
    title: "Approve, watch, learn",
    body: "Agents stream the plan. You approve. They ship. Drift, cost, security — all watched 24/7.",
  },
];

export default async function Home() {
  const session = await getSession();

  return (
    <main className="dda-landing">
      <header className="dda-landing-nav">
        <Logo />
        <nav className="row gap-2">
          <Link href="/design" className="btn ghost sm hide-sm">
            Design system
          </Link>
          {session ? (
            <Link href={"/u/dashboard" as never} className="btn primary sm">
              Open dashboard
              <Icon name="chevR" size={14} />
            </Link>
          ) : (
            <>
              <Link href={"/auth/login" as never} className="btn ghost sm">
                Sign in
              </Link>
              <Link href={"/auth/signup" as never} className="btn primary sm">
                Get started
              </Link>
            </>
          )}
        </nav>
      </header>

      <section className="dda-landing-hero">
        <div className="dda-landing-hero-glow" aria-hidden />
        <div className="dda-landing-hero-inner col gap-4">
          <Badge tone="accent" withDot>
            v1.0 · Now in public beta
          </Badge>
          <h1>
            Run real infrastructure
            <br />
            <span className="dda-landing-grad">without the DevOps team.</span>
          </h1>
          <p className="muted tx-pretty dda-landing-sub">
            Connect a repo, describe what you want, and Deep Agent writes the Terraform and
            Kubernetes, ships it through your environments, and watches it 24/7 — with you approving
            the moves that matter.
          </p>
          <div className="row gap-3 wrap dda-landing-cta">
            {session ? (
              <Link href={"/u/dashboard" as never} className="btn primary lg">
                Open dashboard
                <Icon name="chevR" size={16} />
              </Link>
            ) : (
              <Link href={"/auth/signup" as never} className="btn primary lg">
                Get started — free
                <Icon name="chevR" size={16} />
              </Link>
            )}
            <Link href={"/auth/login" as never} className="btn outline lg">
              Sign in
            </Link>
          </div>
          <div className="row gap-3 faint dda-landing-trust wrap">
            <span className="row gap-2">
              <Icon name="shield" size={13} />
              SOC 2 Type II
            </span>
            <span>·</span>
            <span>99.95% uptime</span>
            <span>·</span>
            <span>Used by 1,284 teams</span>
          </div>
        </div>
      </section>

      <section className="dda-landing-section">
        <div className="dda-landing-features">
          {FEATURES.map((f) => (
            <article key={f.title} className="card card-pad col gap-3 dda-landing-feature">
              <span className="dda-landing-feature-icon">
                <Icon name={f.icon} size={20} />
              </span>
              <h3>{f.title}</h3>
              <p className="muted tx-pretty">{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="dda-landing-section dda-landing-how">
        <div className="col gap-3" style={{ textAlign: "center", maxWidth: 560, margin: "0 auto" }}>
          <span className="faint mono dda-landing-eyebrow">How it works</span>
          <h2>From repo to release in four steps.</h2>
        </div>
        <ol className="dda-landing-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="dda-landing-step">
              <span className="dda-landing-step-num">{i + 1}</span>
              <div className="col gap-1">
                <h4>{s.title}</h4>
                <p className="muted tx-pretty">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="dda-landing-section dda-landing-final">
        <div className="dda-landing-final-card col gap-4 center">
          <h2>Ship infrastructure like product.</h2>
          <p className="muted">Free for 1 project. No credit card.</p>
          <div className="row gap-3 wrap center">
            {session ? (
              <Link href={"/u/dashboard" as never} className="btn primary lg">
                Open dashboard
                <Icon name="chevR" size={16} />
              </Link>
            ) : (
              <Link href={"/auth/signup" as never} className="btn primary lg">
                Get started — free
                <Icon name="chevR" size={16} />
              </Link>
            )}
            <Link href={"/design" as never} className="btn outline lg">
              See the design system
            </Link>
          </div>
        </div>
      </section>

      <footer className="dda-landing-foot">
        <Logo size={24} />
        <div className="row gap-3 faint wrap" style={{ fontSize: 12.5 }}>
          <span>© 2026 DeepAgent</span>
          <span>·</span>
          <Link href={"/auth/login" as never}>Sign in</Link>
          <span>·</span>
          <Link href={"/auth/signup" as never}>Get started</Link>
          <span>·</span>
          <Link href={"/design" as never}>Design system</Link>
        </div>
      </footer>
    </main>
  );
}
