"use client";

import { Badge, Block, Btn, Icon, PageHead, TileGrid } from "@/components/ui";
import { useAdminPlans } from "@/hooks/queries/admin";

export function AdminPlansClient() {
  const { data: plans } = useAdminPlans();
  return (
    <div className="col gap-5">
      <PageHead
        title="Plans"
        sub="Subscription tiers and their entitlements."
        actions={
          <Btn variant="primary" icon="plus">
            New plan
          </Btn>
        }
      />
      {plans ? (
        <TileGrid minTile={250}>
          {plans.map((p) => (
            <div
              key={p.id}
              className="card card-pad col gap-3 dda-plan-card"
              style={{
                borderColor: p.popular ? "var(--accent-line)" : "var(--border)",
                position: "relative",
              }}
            >
              {p.popular && <span className="badge accent dda-plan-pop">Most popular</span>}
              <span className="row gap-2" style={{ fontWeight: 700, fontSize: 15 }}>
                <span className="dot" style={{ background: p.accent, boxShadow: "none" }} />
                {p.name}
              </span>
              <div className="row gap-1" style={{ alignItems: "baseline" }}>
                <span style={{ fontSize: 26, fontWeight: 800 }}>{p.price}</span>
                <span className="muted">{p.period}</span>
              </div>
              <div className="col gap-2" style={{ marginTop: 2 }}>
                {[p.projects, p.envs, p.seats, p.agents].map((f) => (
                  <span key={f} className="row gap-2 muted" style={{ fontSize: 12.5 }}>
                    <Icon name="check" size={14} style={{ color: "var(--ok)", flex: "none" }} />
                    {f}
                  </span>
                ))}
              </div>
              <div className="divider" />
              <div className="row between">
                <span className="faint" style={{ fontSize: 12 }}>
                  <b style={{ color: "var(--text)" }}>{p.active}</b> active
                </span>
                <Btn size="sm" variant="ghost" icon="edit">
                  Edit
                </Btn>
              </div>
            </div>
          ))}
        </TileGrid>
      ) : (
        <Block>
          <Block.Loading />
        </Block>
      )}
    </div>
  );
}
