/**
 * Avatar with deterministic OKLCH gradient from the name (no JS-time randomness).
 * Falls back to initials if no src is provided.
 */
export interface AvatarProps {
  name: string;
  src?: string | null;
  size?: number;
  hue?: number;
}

function hueFromName(name: string): number {
  let total = 0;
  for (let i = 0; i < name.length; i++) total += name.charCodeAt(i);
  return total % 360;
}

export function Avatar({ name, src, size = 34, hue }: AvatarProps) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const h = hue ?? hueFromName(name);
  const background = src
    ? "var(--surface-3)"
    : `linear-gradient(135deg, oklch(0.62 0.16 ${h}), oklch(0.52 0.17 ${(h + 40) % 360}))`;
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background,
      }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        initials
      )}
    </span>
  );
}
