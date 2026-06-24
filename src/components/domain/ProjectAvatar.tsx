/**
 * Deterministic OKLCH gradient avatar for projects. Drives Sidebar
 * ProjectSwitcher tile, dashboard rows, and the Projects tile grid.
 */
export interface ProjectAvatarProps {
  name: string;
  hue: number;
  size?: number;
  radius?: number;
}

export function ProjectAvatar({ name, hue, size = 38, radius }: ProjectAvatarProps) {
  const r = radius ?? Math.max(6, Math.round(size * 0.27));
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        borderRadius: r,
        background: `linear-gradient(135deg, oklch(0.62 0.16 ${hue}), oklch(0.5 0.17 ${(hue + 30) % 360}))`,
      }}
      aria-hidden
    >
      {name[0]?.toUpperCase() ?? "?"}
    </span>
  );
}
