"use client";

import { useEffect, useRef, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";

export interface OtpInputProps {
  value: string;
  onChange: (next: string) => void;
  length?: number;
  autoFocus?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
}

/**
 * 6-digit OTP input with auto-advance, paste, and backspace nav.
 * Value is a string of `length` digits, padded with empty slots until full.
 */
export function OtpInput({
  value,
  onChange,
  length = 6,
  autoFocus = false,
  ariaLabel = "One-time code",
  disabled,
}: OtpInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const chars = Array.from({ length }, (_, i) => value[i] ?? "");

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  function setDigit(i: number, d: string) {
    if (!/^\d?$/.test(d)) return;
    const next = chars.slice();
    next[i] = d;
    onChange(next.join("").slice(0, length));
    if (d && i < length - 1) refs.current[i + 1]?.focus();
  }

  function handleChange(i: number, e: ChangeEvent<HTMLInputElement>) {
    const v = e.target.value.replace(/\D/g, "");
    if (v.length > 1) {
      // probably a paste
      const next = v.split("").slice(0, length - i);
      const merged = chars.slice();
      next.forEach((d, k) => (merged[i + k] = d));
      onChange(merged.join("").slice(0, length));
      const focusIdx = Math.min(i + next.length, length - 1);
      refs.current[focusIdx]?.focus();
      return;
    }
    setDigit(i, v);
  }

  function handleKeyDown(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !chars[i] && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === "ArrowLeft" && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === "ArrowRight" && i < length - 1) {
      refs.current[i + 1]?.focus();
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text").replace(/\D/g, "");
    if (!text) return;
    e.preventDefault();
    onChange(text.slice(0, length).padEnd(length, ""));
    const focusIdx = Math.min(text.length, length - 1);
    refs.current[focusIdx]?.focus();
  }

  return (
    <div className="auth-otp-row" role="group" aria-label={ariaLabel}>
      {chars.map((c, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="input auth-otp-input mono"
          value={c}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={length}
          disabled={disabled}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          aria-label={`Digit ${i + 1}`}
        />
      ))}
    </div>
  );
}
