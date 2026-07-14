"use client";

import { useState, type ReactNode } from "react";
import {
  Avatar,
  Badge,
  Block,
  Btn,
  Empty,
  Field,
  Icon,
  ICONS,
  type IconName,
  Input,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Modal,
  Select,
  StatusDot,
  Tabs,
  Textarea,
  Toggle,
} from "@/components/ui";
import { ACCENTS, DENSITY_SCALE, FONTS, useTweaks } from "@/store/tweaks";

const SECTIONS = [
  { id: "tokens", label: "Tokens" },
  { id: "icon", label: "Icon" },
  { id: "btn", label: "Btn" },
  { id: "badge", label: "Badge + StatusDot" },
  { id: "avatar", label: "Avatar" },
  { id: "field", label: "Field + Input + Textarea" },
  { id: "select", label: "Select" },
  { id: "toggle", label: "Toggle" },
  { id: "menu", label: "Menu" },
  { id: "modal", label: "Modal" },
  { id: "tabs", label: "Tabs" },
  { id: "block", label: "Block" },
  { id: "empty", label: "Empty" },
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} style={{ scrollMarginTop: 80 }}>
      <div className="row between" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, letterSpacing: "-0.01em" }}>{title}</h2>
        <a href={`#${id}`} className="faint mono" style={{ fontSize: 11 }}>
          #{id}
        </a>
      </div>
      <div className="col gap-4">{children}</div>
    </section>
  );
}

function VariantRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row gap-4 wrap" style={{ alignItems: "center" }}>
      <span
        className="mono faint"
        style={{ minWidth: 120, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}
      >
        {label}
      </span>
      <div className="row gap-3 wrap" style={{ alignItems: "center" }}>
        {children}
      </div>
    </div>
  );
}

function TokenSwatch({ name, varName }: { name: string; varName: string }) {
  return (
    <div className="col gap-2" style={{ width: 130 }}>
      <div
        style={{
          width: "100%",
          height: 48,
          borderRadius: 10,
          background: `var(${varName})`,
          border: "1px solid var(--border-soft)",
          boxShadow: "var(--shadow-sm)",
        }}
      />
      <div className="col" style={{ gap: 0 }}>
        <span className="mono" style={{ fontSize: 11 }}>
          {name}
        </span>
        <span className="faint mono" style={{ fontSize: 10 }}>
          {varName}
        </span>
      </div>
    </div>
  );
}

export function DesignSystemClient() {
  const tweaks = useTweaks();
  const [modalOpen, setModalOpen] = useState(false);
  const [tabValue, setTabValue] = useState("overview");
  const [selectValue, setSelectValue] = useState("alpha");
  const [toggleA, setToggleA] = useState(true);
  const [toggleB, setToggleB] = useState(false);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 220px) minmax(0, 1fr)",
        gap: 24,
        maxWidth: 1280,
        margin: "0 auto",
        padding: "24px 20px 80px",
      }}
    >
      {/* Sidebar nav */}
      <aside style={{ position: "sticky", top: 24, alignSelf: "start" }}>
        <div className="card card-pad col gap-3">
          <div className="row between">
            <span className="card-title">Design system</span>
            <Badge tone="accent">Phase 0</Badge>
          </div>
          <div className="col" style={{ gap: 0 }}>
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                style={{
                  padding: "6px 8px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                }}
              >
                {s.label}
              </a>
            ))}
          </div>
        </div>

        {/* Tweaks */}
        <div className="card card-pad col gap-3" style={{ marginTop: 16 }}>
          <span className="card-title">Tweaks</span>
          <Field label="Theme">
            <div className="row gap-2">
              <Btn
                size="sm"
                variant={tweaks.theme === "dark" ? "primary" : "outline"}
                icon="moon"
                onClick={() => tweaks.set({ theme: "dark" })}
              >
                Dark
              </Btn>
              <Btn
                size="sm"
                variant={tweaks.theme === "light" ? "primary" : "outline"}
                icon="sun"
                onClick={() => tweaks.set({ theme: "light" })}
              >
                Light
              </Btn>
            </div>
          </Field>
          <Field label="Accent">
            <div className="row gap-2 wrap">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  onClick={() => tweaks.set({ accent: a.id })}
                  aria-label={a.label}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 99,
                    border:
                      tweaks.accent === a.id ? `2px solid var(--text)` : "1px solid var(--border)",
                    background: `oklch(0.62 0.17 ${a.hue})`,
                    cursor: "pointer",
                  }}
                />
              ))}
            </div>
          </Field>
          <Field label="Density">
            <div className="row gap-2">
              {(Object.keys(DENSITY_SCALE) as Array<keyof typeof DENSITY_SCALE>).map((d) => (
                <Btn
                  key={d}
                  size="sm"
                  variant={tweaks.density === d ? "primary" : "outline"}
                  onClick={() => tweaks.set({ density: d })}
                >
                  {d}
                </Btn>
              ))}
            </div>
          </Field>
          <Field label="Font">
            <Select
              value={tweaks.font}
              onValueChange={(v) => tweaks.set({ font: v as typeof tweaks.font })}
              options={FONTS.map((f) => ({ value: f, label: f }))}
            />
          </Field>
          <Btn size="sm" variant="ghost" icon="refresh" onClick={tweaks.reset}>
            Reset to defaults
          </Btn>
        </div>
      </aside>

      <main className="col gap-6" style={{ minWidth: 0 }}>
        <header className="col gap-2">
          <h1 style={{ fontSize: 28, letterSpacing: "-0.02em" }}>DeepAgent design system</h1>
          <p className="muted" style={{ fontSize: 14, maxWidth: 720 }}>
            Phase 0 sign-off surface. Every primitive listed here is what every later screen will
            compose from. Toggle theme, accent, density and font in the side panel — watch the page
            update without reload.
          </p>
        </header>

        <Section id="tokens" title="Tokens">
          <div className="col gap-4">
            <span className="muted" style={{ fontSize: 12 }}>
              Surface scale
            </span>
            <div className="row gap-3 wrap">
              <TokenSwatch name="bg" varName="--bg" />
              <TokenSwatch name="surface" varName="--surface" />
              <TokenSwatch name="surface-2" varName="--surface-2" />
              <TokenSwatch name="surface-3" varName="--surface-3" />
              <TokenSwatch name="border" varName="--border" />
            </div>
            <span className="muted" style={{ fontSize: 12 }}>
              Accent + status
            </span>
            <div className="row gap-3 wrap">
              <TokenSwatch name="accent" varName="--accent" />
              <TokenSwatch name="accent-strong" varName="--accent-strong" />
              <TokenSwatch name="ok" varName="--ok" />
              <TokenSwatch name="warn" varName="--warn" />
              <TokenSwatch name="danger" varName="--danger" />
              <TokenSwatch name="info" varName="--info" />
            </div>
            <span className="muted" style={{ fontSize: 12 }}>
              Type
            </span>
            <div className="card card-pad col gap-2">
              <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>
                The quick brown fox
              </span>
              <span className="muted">…jumps over the lazy dog (UI font)</span>
              <span className="mono" style={{ fontSize: 13 }}>
                $ deepagent ship --env release
              </span>
            </div>
          </div>
        </Section>

        <Section id="icon" title="Icon registry">
          <Block>
            <Block.Header>
              <Block.Title sub={`${Object.keys(ICONS).length} named SVGs ported from wireframe`}>
                Icons
              </Block.Title>
              <Block.Actions>
                <Badge tone="info">stroke 2, 24-grid</Badge>
              </Block.Actions>
            </Block.Header>
            <Block.Body>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
                  gap: 8,
                }}
              >
                {(Object.keys(ICONS) as IconName[]).map((n) => (
                  <div
                    key={n}
                    className="col center"
                    style={{
                      padding: "12px 8px",
                      borderRadius: 10,
                      border: "1px solid var(--border-soft)",
                      gap: 6,
                      background: "var(--surface-2)",
                    }}
                  >
                    <Icon name={n} size={20} />
                    <span className="mono faint" style={{ fontSize: 10 }}>
                      {n}
                    </span>
                  </div>
                ))}
              </div>
            </Block.Body>
          </Block>
        </Section>

        <Section id="btn" title="Btn">
          <Block>
            <Block.Header>
              <Block.Title>Variants</Block.Title>
            </Block.Header>
            <Block.Body>
              <VariantRow label="variant">
                <Btn>Default</Btn>
                <Btn variant="primary">Primary</Btn>
                <Btn variant="outline">Outline</Btn>
                <Btn variant="ghost">Ghost</Btn>
                <Btn variant="danger">Danger</Btn>
              </VariantRow>
              <VariantRow label="size">
                <Btn size="sm">Small</Btn>
                <Btn>Medium</Btn>
                <Btn size="lg">Large</Btn>
                <Btn size="icon" variant="outline" aria-label="settings">
                  <Icon name="settings" />
                </Btn>
              </VariantRow>
              <VariantRow label="icon">
                <Btn icon="github" variant="outline">
                  Connect GitHub
                </Btn>
                <Btn icon="plus" variant="primary">
                  New project
                </Btn>
                <Btn iconRight="chevR" variant="ghost">
                  Continue
                </Btn>
              </VariantRow>
              <VariantRow label="state">
                <Btn disabled>Disabled</Btn>
                <Btn loading variant="primary">
                  Saving
                </Btn>
                <Btn block variant="outline" style={{ maxWidth: 320 }}>
                  Block (max-width set for demo)
                </Btn>
              </VariantRow>
            </Block.Body>
          </Block>
        </Section>

        <Section id="badge" title="Badge + StatusDot">
          <Block>
            <Block.Header>
              <Block.Title>Tones</Block.Title>
            </Block.Header>
            <Block.Body>
              <VariantRow label="badge">
                <Badge>Default</Badge>
                <Badge tone="ok">Healthy</Badge>
                <Badge tone="warn">Degraded</Badge>
                <Badge tone="danger">Down</Badge>
                <Badge tone="info">Beta</Badge>
                <Badge tone="accent">New</Badge>
                <Badge tone="solid-ok">Live</Badge>
              </VariantRow>
              <VariantRow label="badge w/ icon">
                <Badge tone="ok" icon="check">
                  Verified
                </Badge>
                <Badge tone="warn" icon="alert">
                  2 alerts
                </Badge>
                <Badge tone="info" icon="github">
                  main
                </Badge>
              </VariantRow>
              <VariantRow label="badge w/ dot">
                <Badge tone="ok" withDot>
                  release
                </Badge>
                <Badge tone="warn" withDot>
                  beta
                </Badge>
                <Badge tone="info" withDot>
                  alpha
                </Badge>
              </VariantRow>
              <VariantRow label="status dot">
                <StatusDot tone="ok" label="API healthy" />
                <StatusDot tone="warn" label="Latency" />
                <StatusDot tone="danger" label="DB down" />
                <StatusDot tone="info" pulse label="Live" />
              </VariantRow>
            </Block.Body>
          </Block>
        </Section>

        <Section id="avatar" title="Avatar">
          <Block>
            <Block.Header>
              <Block.Title sub="Deterministic OKLCH gradient from name (no JS randomness)">
                Avatar
              </Block.Title>
            </Block.Header>
            <Block.Body>
              <VariantRow label="size">
                <Avatar name="Avery Chen" size={24} />
                <Avatar name="Avery Chen" size={34} />
                <Avatar name="Avery Chen" size={48} />
                <Avatar name="Avery Chen" size={64} />
              </VariantRow>
              <VariantRow label="varied">
                <Avatar name="Lin Park" />
                <Avatar name="Mira Singh" />
                <Avatar name="Diego Ortiz" />
                <Avatar name="Jules Kim" />
                <Avatar name="Sam Reyes" />
                <Avatar name="Northwind Bot" hue={158} />
              </VariantRow>
            </Block.Body>
          </Block>
        </Section>

        <Section id="field" title="Field + Input + Textarea">
          <Block>
            <Block.Header>
              <Block.Title>Form primitives</Block.Title>
            </Block.Header>
            <Block.Body>
              <div className="col gap-4" style={{ maxWidth: 460 }}>
                <Field label="Email" required hint="Used for sign-in and notifications">
                  <Input type="email" placeholder="you@company.dev" />
                </Field>
                <Field label="Password" required>
                  <Input type="password" placeholder="••••••••" />
                </Field>
                <Field label="With error" error="That slug is already taken">
                  <Input defaultValue="northwind-api" aria-invalid />
                </Field>
                <Field label="Notes">
                  <Textarea placeholder="Optional notes for your team…" />
                </Field>
              </div>
            </Block.Body>
          </Block>
        </Section>

        <Section id="select" title="Select">
          <Block>
            <Block.Header>
              <Block.Title>Accessible select (Radix)</Block.Title>
            </Block.Header>
            <Block.Body>
              <div style={{ maxWidth: 280 }}>
                <Field label="Environment">
                  <Select
                    value={selectValue}
                    onValueChange={setSelectValue}
                    ariaLabel="Environment"
                    options={[
                      { value: "alpha", label: "Alpha" },
                      { value: "beta", label: "Beta" },
                      { value: "release", label: "Release" },
                      { value: "staging", label: "Staging (disabled)", disabled: true },
                    ]}
                  />
                </Field>
              </div>
            </Block.Body>
          </Block>
        </Section>

        <Section id="toggle" title="Toggle">
          <Block>
            <Block.Header>
              <Block.Title>Switch</Block.Title>
            </Block.Header>
            <Block.Body>
              <VariantRow label="state">
                <Toggle checked={toggleA} onCheckedChange={setToggleA} ariaLabel="A" />
                <Toggle checked={toggleB} onCheckedChange={setToggleB} ariaLabel="B" />
                <Toggle defaultChecked disabled ariaLabel="disabled on" />
                <Toggle disabled ariaLabel="disabled off" />
              </VariantRow>
            </Block.Body>
          </Block>
        </Section>

        <Section id="menu" title="Menu">
          <Block>
            <Block.Header>
              <Block.Title sub="Used for row kebab + user + notifications dropdowns">
                Dropdown menu
              </Block.Title>
            </Block.Header>
            <Block.Body>
              <VariantRow label="trigger">
                <Menu
                  trigger={
                    <Btn variant="outline" iconRight="chevD">
                      Open menu
                    </Btn>
                  }
                >
                  <MenuLabel>Account</MenuLabel>
                  <MenuItem icon="user">Profile</MenuItem>
                  <MenuItem icon="edit">Edit profile</MenuItem>
                  <MenuItem icon="key">Change password</MenuItem>
                  <MenuItem icon="settings">Account settings</MenuItem>
                  <MenuSeparator />
                  <MenuItem icon="logout" danger>
                    Log out
                  </MenuItem>
                </Menu>
                <Menu
                  trigger={
                    <Btn variant="outline" size="icon" aria-label="More">
                      <Icon name="more" />
                    </Btn>
                  }
                  align="end"
                >
                  <MenuItem icon="eye">View</MenuItem>
                  <MenuItem icon="edit">Edit</MenuItem>
                  <MenuItem icon="trash" danger>
                    Delete
                  </MenuItem>
                </Menu>
              </VariantRow>
            </Block.Body>
          </Block>
        </Section>

        <Section id="modal" title="Modal">
          <Block>
            <Block.Header>
              <Block.Title sub="Radix Dialog with focus trap, Escape, backdrop close">
                Modal
              </Block.Title>
            </Block.Header>
            <Block.Body>
              <Btn variant="primary" icon="plus" onClick={() => setModalOpen(true)}>
                Open modal
              </Btn>
              <Modal
                open={modalOpen}
                onOpenChange={setModalOpen}
                title="Invite team member"
                description="They will receive an email to join this project"
                footer={
                  <>
                    <Btn variant="ghost" onClick={() => setModalOpen(false)}>
                      Cancel
                    </Btn>
                    <Btn variant="primary" icon="send" onClick={() => setModalOpen(false)}>
                      Send invite
                    </Btn>
                  </>
                }
              >
                <div className="col gap-3">
                  <Field label="Email" required>
                    <Input type="email" placeholder="teammate@northwind.dev" autoFocus />
                  </Field>
                  <Field label="Role">
                    <Select
                      defaultValue="contributor"
                      ariaLabel="Role"
                      options={[
                        { value: "owner", label: "Owner" },
                        { value: "contributor", label: "Contributor" },
                        { value: "member", label: "Member" },
                      ]}
                    />
                  </Field>
                </div>
              </Modal>
            </Block.Body>
          </Block>
        </Section>

        <Section id="tabs" title="Tabs">
          <Block>
            <Block.Header>
              <Block.Title>Tabs (Radix)</Block.Title>
            </Block.Header>
            <Block.Body>
              <Tabs
                value={tabValue}
                onValueChange={setTabValue}
                items={[
                  {
                    value: "overview",
                    label: "Overview",
                    content: <p className="muted">Overview content. Compose any block here.</p>,
                  },
                  {
                    value: "repos",
                    label: "Repositories",
                    content: <p className="muted">Repositories tab.</p>,
                  },
                  {
                    value: "reviews",
                    label: "Agent reviews",
                    content: <p className="muted">Agent reviews tab.</p>,
                  },
                  {
                    value: "settings",
                    label: "Settings",
                    content: <p className="muted">Settings tab.</p>,
                  },
                ]}
              />
            </Block.Body>
          </Block>
        </Section>

        <Section id="block" title="Block">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 16,
            }}
          >
            <Block>
              <Block.Header>
                <Block.Title sub="Header + Title + Actions">Recent pipelines</Block.Title>
                <Block.Actions>
                  <Btn size="sm" variant="ghost" iconRight="chevR">
                    View all
                  </Btn>
                </Block.Actions>
              </Block.Header>
              <Block.Body>
                <p className="muted" style={{ fontSize: 13 }}>
                  Body content. Lists, charts, tables — all compose inside Block.Body.
                </p>
              </Block.Body>
            </Block>

            <Block>
              <Block.Header>
                <Block.Title>Header + Toolbar + Body</Block.Title>
                <Block.Actions>
                  <Btn size="sm" variant="outline" icon="filter">
                    Filter
                  </Btn>
                </Block.Actions>
              </Block.Header>
              <Block.Toolbar>
                <Badge tone="info" withDot>
                  alpha
                </Badge>
                <Badge tone="warn" withDot>
                  beta
                </Badge>
                <Badge tone="ok" withDot>
                  release
                </Badge>
                <div className="grow" />
                <span className="faint" style={{ fontSize: 12 }}>
                  3 envs
                </span>
              </Block.Toolbar>
              <Block.Body>
                <p className="muted" style={{ fontSize: 13 }}>
                  Toolbar is a thin row beneath the header for filters / chips / counters.
                </p>
              </Block.Body>
            </Block>

            <Block>
              <Block.Header>
                <Block.Title>Loading state</Block.Title>
              </Block.Header>
              <Block.Loading />
            </Block>

            <Block>
              <Block.Header>
                <Block.Title>Empty state</Block.Title>
              </Block.Header>
              <Block.Empty
                icon="cloud"
                title="No cloud providers"
                description="Connect AWS or GCP to start provisioning."
                action={
                  <Btn size="sm" variant="primary" icon="plus">
                    Connect provider
                  </Btn>
                }
              />
            </Block>

            <Block>
              <Block.Header>
                <Block.Title>Error state</Block.Title>
              </Block.Header>
              <Block.Error message="We couldn't reach the runner. Try again in a moment." />
            </Block>
          </div>
        </Section>

        <Section id="empty" title="Empty">
          <Block>
            <Block.Header>
              <Block.Title>Empty primitive</Block.Title>
            </Block.Header>
            <Block.Body>
              <Empty
                icon="search"
                title="No matches"
                description="Try clearing filters or searching by repo name."
                action={
                  <Btn size="sm" variant="outline">
                    Clear filters
                  </Btn>
                }
              />
            </Block.Body>
          </Block>
        </Section>
      </main>
    </div>
  );
}
