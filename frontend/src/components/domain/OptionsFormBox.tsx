"use client";

/**
 * Batch options form — one card with N questions and a single Submit button.
 * Rendered from a ```options-form``` fenced block in an agent message.
 * Purpose-built for flows where the agent needs several answers at once
 * instead of one round-trip per question (e.g. the deploy pipeline's
 * namespace/registry/manifest-type/CI-CD picks, or the RDS wizard's
 * name/engine/storage picks).
 *
 * Two question kinds:
 *   - SELECT (default): a fixed set of choices, rendered as radio pills.
 *     `{"key": "namespace", "question": "Which namespace?",
 *       "options": ["default", "kube-system", "Create new: myapp"]}`
 *   - FREE INPUT: open text or a number, when the answer can't be a fixed
 *     list (a resource name, a storage size). `{"key": "name",
 *       "question": "Database name", "kind": "text", "default": "myapp-db"}`
 *     `kind` is "text" or "number"; omit `options` entirely for these.
 *
 * The submitted message text is a compact "key: value, key: value" string the
 * LLM reads back and threads directly into the next tool call. Format kept
 * agent-friendly (comma-separated key: value pairs) so no additional parsing
 * playbook rule is needed on the agent side.
 *
 * JSON shape inside the fence:
 *   {
 *     "questions": [
 *       {"key": "namespace", "question": "Which namespace?",
 *        "options": ["default", "kube-system", "Create new: myapp"]},
 *       {"key": "name", "question": "Database name", "kind": "text", "default": "myapp-db"},
 *       {"key": "storage", "question": "Storage (GB)", "kind": "number", "default": "20"}
 *     ],
 *     "submitLabel": "Deploy"
 *   }
 */
import { useMemo, useState } from "react";
import { Btn, Input, Select, type SelectOption } from "@/components/ui";

export type OptionsFormSelectQuestion = {
  key: string;
  question: string;
  options: string[];
  /**
   * Rendering shape for the choices:
   *   - undefined | "pills"  → radio-style pill buttons (compact, ideal for
   *                            2-6 short options like yes/no, dev/staging/prod)
   *   - "dropdown"           → native <Select> control (ideal for LONG lists
   *                            like AWS regions, instance types — dozens of
   *                            options that would visually overwhelm as pills)
   */
  as?: "pills" | "dropdown";
  /** Optional default value; must match one of `options` exactly to take effect. */
  default?: string;
};

export type OptionsFormInputQuestion = {
  key: string;
  question: string;
  kind: "text" | "number";
  default?: string;
  placeholder?: string;
};

export type OptionsFormQuestion = OptionsFormSelectQuestion | OptionsFormInputQuestion;

export type OptionsFormData = {
  questions: OptionsFormQuestion[];
  /** Text on the submit button. Defaults to "Continue". */
  submitLabel?: string;
  /** Optional intro shown above the questions. */
  intro?: string;
};

function isInputQuestion(q: OptionsFormQuestion): q is OptionsFormInputQuestion {
  return "kind" in q && (q.kind === "text" || q.kind === "number");
}

export function OptionsFormBox({
  data,
  interactive,
  onSubmit,
}: {
  data: OptionsFormData;
  interactive: boolean;
  onSubmit?: (formatted: string) => void;
}) {
  // Seed each question's initial answer from its `default` — select questions
  // only when the default matches an option (so a stale/invalid default
  // doesn't silently pick something), free-input questions always (a
  // suggested value the user can edit or accept as-is).
  const initial = useMemo(() => {
    const out: Record<string, string> = {};
    for (const q of data.questions) {
      // The fence's JSON comes from the LLM, not a schema-checked API — a
      // "default" on a number-kind question is very plausibly a bare JSON
      // number (20, not "20"). Coerce everything to a string on the way in
      // so `answers` is never anything but strings.
      if (isInputQuestion(q)) {
        if (q.default !== undefined && q.default !== null) out[q.key] = String(q.default);
      } else if (q.default !== undefined && q.options.map(String).includes(String(q.default))) {
        out[q.key] = String(q.default);
      }
    }
    return out;
  }, [data]);

  const [answers, setAnswers] = useState<Record<string, string>>(initial);
  const [submitted, setSubmitted] = useState(false);
  const allAnswered = data.questions.every((q) => String(answers[q.key] ?? "").trim().length > 0);

  function handleSubmit() {
    if (!allAnswered || !interactive || submitted) return;
    // Serialize as "namespace: default, name: myapp-db" — stable ordering
    // (question order), one-line, comma-separated.
    const parts = data.questions.map((q) => `${q.key}: ${answers[q.key]}`);
    setSubmitted(true);
    onSubmit?.(parts.join(", "));
  }

  return (
    <div
      className="card"
      style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}
    >
      {data.intro && <div style={{ fontSize: 13 }}>{data.intro}</div>}
      {data.questions.map((q) =>
        isInputQuestion(q) ? (
          <fieldset
            key={q.key}
            style={{
              border: 0,
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <legend style={{ fontWeight: 600, fontSize: 13, padding: 0 }}>{q.question}</legend>
            <Input
              type={q.kind === "number" ? "number" : "text"}
              value={answers[q.key] ?? ""}
              placeholder={q.placeholder}
              disabled={!interactive || submitted}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [q.key]: e.target.value }))}
              style={{ maxWidth: 280, fontSize: 13 }}
            />
          </fieldset>
        ) : q.as === "dropdown" ? (
          <fieldset
            key={q.key}
            style={{
              border: 0,
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <legend style={{ fontWeight: 600, fontSize: 13, padding: 0 }}>{q.question}</legend>
            <Select
              options={q.options.map((raw): SelectOption => ({ value: String(raw), label: String(raw) }))}
              value={answers[q.key] ?? ""}
              onValueChange={(v) => setAnswers((prev) => ({ ...prev, [q.key]: v }))}
              disabled={!interactive || submitted}
              ariaLabel={q.question}
              placeholder="Pick one…"
            />
          </fieldset>
        ) : (
          <fieldset
            key={q.key}
            style={{
              border: 0,
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <legend style={{ fontWeight: 600, fontSize: 13, padding: 0 }}>{q.question}</legend>
            {/* maxHeight caps the wrap area so a question with many options
                (e.g. 20+ branches) can't push the Submit button off-screen.
                Roughly 4 rows of pills; taller lists scroll inside the box. */}
            <div
              className="row gap-2 wrap"
              style={{ maxHeight: 132, overflowY: "auto", paddingRight: 2 }}
            >
              {q.options.map((raw) => {
                // Coerce defensively — the fence's JSON comes from the LLM,
                // not a schema-checked API, so an "options" entry could in
                // theory be a bare number rather than a string.
                const o = String(raw);
                const selected = answers[q.key] === o;
                return (
                  <label
                    key={o}
                    style={{
                      position: "relative",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 10px",
                      fontSize: 12.5,
                      fontWeight: selected ? 600 : 400,
                      border: selected
                        ? "1px solid var(--accent, #6c5ce7)"
                        : "1px solid var(--border, #ddd)",
                      borderRadius: 6,
                      cursor: interactive && !submitted ? "pointer" : "default",
                      background: selected ? "var(--accent-soft, #eef4ff)" : "transparent",
                      color: selected ? "var(--accent, #6c5ce7)" : undefined,
                      boxShadow: selected ? "0 0 0 1px var(--accent, #6c5ce7) inset" : "none",
                      opacity: interactive && !submitted ? 1 : 0.75,
                      transition: "background 100ms, border-color 100ms",
                    }}
                    onMouseDown={(e) => {
                      // Prevent focus (and its default scroll-into-view) on the
                      // hidden radio when the pill is clicked with a mouse.
                      // Keyboard users still tab-focus normally.
                      e.preventDefault();
                      setAnswers((prev) => ({ ...prev, [q.key]: o }));
                    }}
                  >
                    {/* Visually-hidden radio — keeps keyboard focus + a11y semantics; we render our own indicator. */}
                    <input
                      type="radio"
                      name={q.key}
                      value={o}
                      checked={selected}
                      disabled={!interactive || submitted}
                      onChange={() => setAnswers((prev) => ({ ...prev, [q.key]: o }))}
                      style={{
                        position: "absolute",
                        width: 1,
                        height: 1,
                        padding: 0,
                        margin: -1,
                        overflow: "hidden",
                        clip: "rect(0 0 0 0)",
                        border: 0,
                      }}
                    />
                    <span
                      aria-hidden
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 12,
                        height: 12,
                        fontSize: 11,
                        lineHeight: 1,
                        color: "var(--accent, #6c5ce7)",
                      }}
                    >
                      {selected ? "✓" : ""}
                    </span>
                    <span>{o}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ),
      )}
      <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
        <Btn
          size="sm"
          variant="primary"
          disabled={!interactive || submitted || !allAnswered}
          onClick={handleSubmit}
        >
          {submitted ? "Sent" : data.submitLabel || "Continue"}
        </Btn>
      </div>
    </div>
  );
}
