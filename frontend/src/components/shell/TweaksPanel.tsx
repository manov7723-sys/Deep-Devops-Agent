"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { type ReactNode } from "react";
import { Btn, Field, Icon, Select } from "@/components/ui";
import { ACCENTS, DENSITY_SCALE, FONTS, useTweaks } from "@/store/tweaks";
import { useChaos } from "@/lib/api/chaos";

export interface TweaksPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactNode;
}

export function TweaksPanel({ open, onOpenChange }: TweaksPanelProps) {
  const tweaks = useTweaks();
  const chaos = useChaos();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" style={{ zIndex: 200 }} />
        <Dialog.Content className="dda-tweaks-sheet col">
          <div className="card-h">
            <Dialog.Title asChild>
              <span className="card-title">Appearance</span>
            </Dialog.Title>
            <Dialog.Close asChild>
              <Btn variant="ghost" size="icon" aria-label="Close">
                <Icon name="x" size={16} />
              </Btn>
            </Dialog.Close>
          </div>
          <Dialog.Description asChild>
            <p className="muted card-pad" style={{ fontSize: 12.5, paddingBottom: 0 }}>
              Theme, accent, density and font preferences. Saved to this device.
            </p>
          </Dialog.Description>

          <div className="card-pad col gap-4">
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
                    type="button"
                    onClick={() => tweaks.set({ accent: a.id })}
                    aria-label={a.label}
                    className="dda-tweak-swatch"
                    data-active={tweaks.accent === a.id}
                    style={{ background: `oklch(0.62 0.17 ${a.hue})` }}
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

            <Btn variant="ghost" size="sm" icon="refresh" onClick={tweaks.reset}>
              Reset to defaults
            </Btn>

            <div className="divider" style={{ margin: "8px 0 4px" }} />
            <span className="field-label">Mock chaos (demo)</span>
            <p className="faint" style={{ fontSize: 11.5, marginTop: -4 }}>
              Inject latency or failure to exercise loading + error states across every screen.
            </p>

            <Field label="Latency">
              <Select
                value={chaos.latency}
                onValueChange={(v) => chaos.set({ latency: v as typeof chaos.latency })}
                ariaLabel="Mock latency"
                options={[
                  { value: "off", label: "Off" },
                  { value: "slow", label: "Slow (900 ms)" },
                  { value: "very-slow", label: "Very slow (2.4 s)" },
                ]}
              />
            </Field>
            <Field label="Failure rate">
              <Select
                value={chaos.failure}
                onValueChange={(v) => chaos.set({ failure: v as typeof chaos.failure })}
                ariaLabel="Mock failure rate"
                options={[
                  { value: "off", label: "Off" },
                  { value: "10%", label: "10% of requests" },
                  { value: "50%", label: "50% of requests" },
                  { value: "always", label: "All requests fail" },
                ]}
              />
            </Field>
            <Btn variant="ghost" size="sm" icon="refresh" onClick={chaos.reset}>
              Reset chaos
            </Btn>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
