"use client";

import { Btn, Icon } from "@/components/ui";

export const HUES = [285, 255, 200, 158, 95, 35, 12, 235] as const;
export type Hue = (typeof HUES)[number];

export interface HuePickerProps {
  value: number;
  onChange: (hue: number) => void;
  /** Optional upload trigger — opens file picker in consumer. */
  onUpload?: () => void;
}

/**
 * OKLCH swatch row used by project / icon picking. Drives the Project.color hue,
 * which the Avatar and ProjectAvatar gradients read from.
 */
export function HuePicker({ value, onChange, onUpload }: HuePickerProps) {
  return (
    <div className="row gap-2 wrap" role="radiogroup" aria-label="Color">
      {HUES.map((h) => {
        const active = value === h;
        return (
          <button
            key={h}
            type="button"
            onClick={() => onChange(h)}
            role="radio"
            aria-checked={active}
            aria-label={`Hue ${h}`}
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              cursor: "pointer",
              flex: "none",
              background: `linear-gradient(135deg, oklch(0.62 0.16 ${h}), oklch(0.5 0.17 ${(h + 30) % 360}))`,
              border: active ? "2px solid var(--text)" : "2px solid transparent",
              outline: active ? "none" : "1px solid var(--border)",
            }}
          />
        );
      })}
      {onUpload && (
        <Btn variant="outline" size="icon" aria-label="Upload image" onClick={onUpload}>
          <Icon name="download" size={13} />
        </Btn>
      )}
    </div>
  );
}
