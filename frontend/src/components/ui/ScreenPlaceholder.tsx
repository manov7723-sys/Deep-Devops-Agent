import { Badge, Block, Btn, Icon, type IconName } from "@/components/ui";

export interface ScreenPlaceholderProps {
  area: "user" | "admin" | "project";
  title: string;
  icon: IconName;
  /** Which phase will fill this screen in — shown as a chip. */
  comingInPhase: number;
  /** Short list of what's planned for this screen. */
  highlights?: string[];
  /** Optional project context (e.g. "Northwind API"). */
  contextLabel?: string;
}

const areaLabel: Record<ScreenPlaceholderProps["area"], string> = {
  user: "User",
  admin: "Super Admin",
  project: "Project workspace",
};

export function ScreenPlaceholder({
  area,
  title,
  icon,
  comingInPhase,
  highlights,
  contextLabel,
}: ScreenPlaceholderProps) {
  return (
    <div className="col gap-4">
      <div className="row gap-3 wrap" style={{ alignItems: "center" }}>
        <span
          className="row center"
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: "var(--accent-soft)",
            color: "var(--accent)",
          }}
        >
          <Icon name={icon} size={22} />
        </span>
        <div className="col" style={{ gap: 2 }}>
          <h1 style={{ fontSize: 22, letterSpacing: "-0.02em" }}>{title}</h1>
          <div className="row gap-2 muted" style={{ fontSize: 12.5 }}>
            <span>{areaLabel[area]}</span>
            {contextLabel && (
              <>
                <span>·</span>
                <span>{contextLabel}</span>
              </>
            )}
          </div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <Badge tone="accent">Coming in Phase {comingInPhase}</Badge>
        </div>
      </div>

      <Block>
        <Block.Header>
          <Block.Title sub="The shell is live. This screen lands in a later phase.">
            What this will hold
          </Block.Title>
          <Block.Actions>
            <Btn size="sm" variant="ghost" icon="book">
              Wireframe
            </Btn>
          </Block.Actions>
        </Block.Header>
        <Block.Body>
          {highlights ? (
            <ul className="col gap-2" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {highlights.map((h) => (
                <li key={h} className="row gap-2" style={{ fontSize: 13.5 }}>
                  <Icon name="check" size={14} style={{ color: "var(--accent)" }} />
                  {h}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>
              Sign-off in the screen-specific phase.
            </p>
          )}
        </Block.Body>
      </Block>
    </div>
  );
}
