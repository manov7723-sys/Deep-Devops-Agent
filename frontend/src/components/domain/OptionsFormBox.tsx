"use client";

/**
 * Batch options form — one card with N radio-group questions and a single
 * Submit button. Rendered from a ```options-form``` fenced block in an agent
 * message. Purpose-built for the deploy pipeline: instead of the agent asking
 * namespace → then branch → then registry over 3 round-trips, it emits ONE
 * form with all 3 questions and the user answers them together in a single
 * chat submission.
 *
 * The submitted message text is a compact "key: value, key: value" string the
 * LLM reads back and threads directly into deploy_my_app(...). Format kept
 * agent-friendly (comma-separated key: value pairs) so no additional parsing
 * playbook rule is needed on the agent side.
 *
 * JSON shape inside the fence:
 *   {
 *     "questions": [
 *       {"key": "namespace", "question": "Which namespace?",
 *        "options": ["default", "kube-system", "Create new: myapp"]},
 *       {"key": "branch",    "question": "Which branch?",
 *        "options": ["main", "master", "Create new: main"]},
 *       {"key": "registry_app", "question": "Which registry for app?",
 *        "options": ["agentmy", "Create new: dynamic-react-app"]}
 *     ],
 *     "submitLabel": "Deploy"
 *   }
 */
import { useMemo, useState } from "react";
import { Btn } from "@/components/ui";

export type OptionsFormQuestion = {
  key: string;
  question: string;
  options: string[];
  /** Optional default value; must match one of `options` exactly to take effect. */
  default?: string;
};

export type OptionsFormData = {
  questions: OptionsFormQuestion[];
  /** Text on the submit button. Defaults to "Continue". */
  submitLabel?: string;
  /** Optional intro shown above the questions. */
  intro?: string;
};

export function OptionsFormBox({
  data,
  interactive,
  onSubmit,
}: {
  data: OptionsFormData;
  interactive: boolean;
  onSubmit?: (formatted: string) => void;
}) {
  // Seed each question's initial answer from its `default` (when it matches an
  // option) so the user sees a suggested pick they can confirm with one click.
  const initial = useMemo(() => {
    const out: Record<string, string> = {};
    for (const q of data.questions) {
      if (q.default && q.options.includes(q.default)) out[q.key] = q.default;
    }
    return out;
  }, [data]);

  const [answers, setAnswers] = useState<Record<string, string>>(initial);
  const [submitted, setSubmitted] = useState(false);
  const allAnswered = data.questions.every((q) => !!answers[q.key]);

  function handleSubmit() {
    if (!allAnswered || !interactive || submitted) return;
    // Serialize as "namespace: default, branch: main, registry_app: agentmy" —
    // stable ordering (question order), one-line, comma-separated.
    const parts = data.questions.map((q) => `${q.key}: ${answers[q.key]}`);
    setSubmitted(true);
    onSubmit?.(parts.join(", "));
  }

  return (
    <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
      {data.intro && <div style={{ fontSize: 13 }}>{data.intro}</div>}
      {data.questions.map((q) => (
        <fieldset
          key={q.key}
          style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}
        >
          <legend style={{ fontWeight: 600, fontSize: 13, padding: 0 }}>{q.question}</legend>
          {/* maxHeight caps the wrap area so a question with many options
              (e.g. 20+ branches) can't push the Submit button off-screen.
              Roughly 4 rows of pills; taller lists scroll inside the box. */}
          <div className="row gap-2 wrap" style={{ maxHeight: 132, overflowY: "auto", paddingRight: 2 }}>
            {q.options.map((o) => {
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
      ))}
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
