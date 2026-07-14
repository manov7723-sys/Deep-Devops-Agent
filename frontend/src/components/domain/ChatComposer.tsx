"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Btn, Icon, type IconName } from "@/components/ui";
import type { SeedChatSuggestion } from "@/lib/legacy-types";

export interface ChatComposerProps {
  suggestions?: SeedChatSuggestion[];
  /** Master switch for the suggestion chips (they also hide while the user is typing). */
  showSuggestions?: boolean;
  onSend: (text: string) => void;
  disabled?: boolean;
}

const MAX_TEXTAREA_HEIGHT = 200;

export function ChatComposer({
  suggestions = [],
  showSuggestions = true,
  onSend,
  disabled,
}: ChatComposerProps) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow to fit content up to MAX_TEXTAREA_HEIGHT, then scroll internally.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [text]);

  function submit(value?: string) {
    const t = (value ?? text).trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="col gap-3" style={{ maxWidth: 820, margin: "0 auto", width: "100%" }}>
      {showSuggestions && suggestions.length > 0 && !text.trim() && (
        <div className="row gap-2 wrap">
          {suggestions.map((s, i) => (
            <button
              key={`${s.text}-${i}`}
              type="button"
              className="chip"
              onClick={() => submit(s.text)}
              disabled={disabled}
            >
              <Icon name={s.icon as IconName} size={14} style={{ color: "var(--accent)" }} />
              {s.text}
            </button>
          ))}
        </div>
      )}
      <div className="dda-chat-composer">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Describe what you want to build or change…"
          disabled={disabled}
          aria-label="Message"
          rows={1}
          className="dda-chat-composer-input"
        />
        <div className="row gap-2 dda-chat-composer-actions">
          <Btn variant="ghost" size="icon" aria-label="Attach" disabled={disabled}>
            <Icon name="plus" size={18} />
          </Btn>
          <Btn variant="ghost" size="sm" icon="layers" disabled={disabled}>
            infra
          </Btn>
          <span style={{ flex: 1 }} />
          <Btn
            variant="primary"
            size="icon"
            aria-label="Send"
            onClick={() => submit()}
            disabled={disabled || !text.trim()}
          >
            <Icon name="send" size={16} />
          </Btn>
        </div>
      </div>
      <p className="faint" style={{ fontSize: 11, textAlign: "center" }}>
        Deep Agent can read and write to your repos. Changes require approval before they touch release.
      </p>
    </div>
  );
}
