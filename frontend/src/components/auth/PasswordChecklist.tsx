"use client";

import { Icon } from "@/components/ui";

export type PasswordRequirement = {
  label: string;
  test: (pw: string) => boolean;
};

export const PASSWORD_REQS: PasswordRequirement[] = [
  { label: "8+ characters", test: (p) => p.length >= 8 },
  { label: "One number", test: (p) => /\d/.test(p) },
  { label: "One symbol", test: (p) => /[^A-Za-z0-9]/.test(p) },
];

export function evaluatePassword(pw: string): { met: boolean[]; allMet: boolean } {
  const met = PASSWORD_REQS.map((r) => r.test(pw));
  return { met, allMet: met.every(Boolean) };
}

export interface PasswordChecklistProps {
  password: string;
  requirements?: PasswordRequirement[];
}

export function PasswordChecklist({ password, requirements = PASSWORD_REQS }: PasswordChecklistProps) {
  return (
    <div className="auth-pwd-checklist" aria-live="polite">
      {requirements.map((r) => {
        const met = r.test(password);
        return (
          <div key={r.label} className={`auth-pwd-req ${met ? "met" : "unmet"}`}>
            <Icon name={met ? "check" : "x"} size={14} />
            {r.label}
          </div>
        );
      })}
    </div>
  );
}
