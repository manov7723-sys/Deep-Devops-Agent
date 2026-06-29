import type { ReactNode } from "react";
import { Icon } from "@/components/ui";
import { Logo } from "@/components/shell/Logo";

const FEATURES: Array<{ icon: "zap" | "shield" | "approve"; label: string }> = [
  { icon: "zap", label: "Generate Terraform & K8s from a prompt" },
  { icon: "shield", label: "Agents review every change against requirements" },
  { icon: "approve", label: "Human-in-the-loop approvals on risky steps" },
];

export interface AuthFrameProps {
  children: ReactNode;
  foot?: ReactNode;
}

/**
 * Two-column auth shell. Brand panel on the left (collapses below 900px),
 * form column on the right with a small mobile logo above the form.
 */
export function AuthFrame({ children, foot }: AuthFrameProps) {
  return (
    <div className="auth-frame">
      <aside className="auth-brand">
        <div className="auth-brand-glow" />
        <div className="auth-brand-inner">
          <Logo size={34} />
          <div className="auth-brand-pitch">
            <h1>Run real infrastructure without the DevOps team.</h1>
            <p className="muted tx-pretty">
              Connect a repo, describe what you want, and Deep Agent writes the Terraform and
              Kubernetes, ships it through your environments, and watches it 24/7 — with you
              approving the moves that matter.
            </p>
            <div className="col gap-3" style={{ marginTop: 8 }}>
              {FEATURES.map((f) => (
                <div key={f.icon} className="row gap-3">
                  <span className="auth-feat">
                    <Icon name={f.icon} size={17} />
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{f.label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="row gap-3 faint auth-brand-foot">
            <span>SOC 2 Type II</span>
            <span>·</span>
            <span>99.95% uptime</span>
            <span>·</span>
            <span>© 2026 DeepAgent</span>
          </div>
        </div>
      </aside>

      <section className="auth-form-wrap">
        <div className="auth-form-col">
          <div className="auth-logo-mobile">
            <Logo size={32} />
          </div>
          {children}
          {foot}
        </div>
      </section>
    </div>
  );
}
