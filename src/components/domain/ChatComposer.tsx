"use client";

import { useState, type KeyboardEvent } from "react";
import { Btn, Icon, type IconName } from "@/components/ui";
import type { SeedChatSuggestion } from "@/lib/legacy-types";

export interface ChatComposerProps {
  suggestions?: SeedChatSuggestion[];
  /** Show suggestion chips above the input. Hidden after the first user reply. */
  showSuggestions?: boolean;
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function ChatComposer({
  suggestions = [],
  showSuggestions = true,
  onSend,
  disabled,
}: ChatComposerProps) {
  const [text, setText] = useState("");

  function submit(value?: string) {
    const t = (value ?? text).trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="col gap-3" style={{ maxWidth: 820, margin: "0 auto", width: "100%" }}>
      {showSuggestions && suggestions.length > 0 && (
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
      <div className="row gap-2 dda-chat-composer">
        <Btn variant="ghost" size="icon" aria-label="Attach" disabled={disabled}>
          <Icon name="plus" size={18} />
        </Btn>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Describe what you want to build or change…"
          disabled={disabled}
          aria-label="Message"
          className="dda-chat-composer-input"
        />
        <Btn variant="ghost" size="sm" icon="layers" disabled={disabled}>
          infra
        </Btn>
        <Btn variant="primary" size="icon" aria-label="Send" onClick={() => submit()} disabled={disabled}>
          <Icon name="send" size={16} />
        </Btn>
      </div>
      <p className="faint" style={{ fontSize: 11, textAlign: "center" }}>
        Deep Agent can read and write to your repos. Changes require approval before they touch release.
      </p>
    </div>
  );
}
