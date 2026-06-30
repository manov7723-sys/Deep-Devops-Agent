/**
 * DeepAgent logo. The pre-hydration ThemeScript drives accent-h on :root so the
 * SVG fill follows the current accent without prop changes.
 */
export interface LogoProps {
  size?: number;
  compact?: boolean;
}

export function Logo({ size = 28, compact }: LogoProps) {
  return (
    <div className="row gap-3" style={{ userSelect: "none" }}>
      <svg width={size} height={size} viewBox="0 0 32 32" style={{ flex: "none" }} aria-hidden>
        <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--accent)" />
        <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#dda-logo-grad)" />
        <defs>
          <linearGradient id="dda-logo-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="white" stopOpacity="0.22" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
        </defs>
        <circle cx="11" cy="11" r="2.4" fill="white" />
        <circle cx="21" cy="11" r="2.4" fill="white" fillOpacity="0.7" />
        <circle cx="16" cy="21" r="2.4" fill="white" />
        <path
          d="M11 11 L21 11 M11 11 L16 21 M21 11 L16 21"
          stroke="white"
          strokeWidth="1.6"
          strokeOpacity="0.55"
          strokeLinecap="round"
        />
      </svg>
      {!compact && (
        <div className="col" style={{ lineHeight: 1.05 }}>
          <span style={{ fontWeight: 800, fontSize: 14.5, letterSpacing: "-0.02em" }}>
            DeepAgent DevOps
          </span>
          <span
            className="faint mono"
            style={{ fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase" }}
          >
            autonomous infra
          </span>
        </div>
      )}
    </div>
  );
}
