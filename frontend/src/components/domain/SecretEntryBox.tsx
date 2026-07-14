"use client";

/**
 * Set an app secret — a masked key/value form so the raw value never enters
 * the chat transcript or an LLM tool-call argument (unlike set_app_secret,
 * which the agent must NOT use for chat-typed values — see the system
 * prompt). Posts straight to the existing secrets REST route. No LLM.
 * Rendered inline in chat via the ```secret-entry``` fence.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Block, Btn, Field, Icon, Input } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type SecretKey = { key: string; updatedAt: string };

export function SecretEntryBox({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const keysQ = useQuery<{ ok: boolean; secrets: SecretKey[] }>({
    queryKey: ["p", slug, "secret-keys"],
    queryFn: () => api.get<{ ok: boolean; secrets: SecretKey[] }>(`/projects/${slug}/secrets`),
    staleTime: 10_000,
  });

  const save = useMutation({
    mutationFn: () =>
      api.put<{ ok: boolean }>(`/projects/${slug}/secrets`, { key: key.trim(), value }),
    onMutate: () => setErr(null),
    onSuccess: () => {
      setSavedKey(key.trim());
      setKey("");
      setValue("");
      qc.invalidateQueries({ queryKey: ["p", slug, "secret-keys"] });
    },
    onError: (e) => setErr(apiErrorMessage(e, "Could not save secret.")),
  });

  const canSave =
    /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key.trim()) && value.length > 0 && !save.isPending;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Stored encrypted; the value never appears in chat. Sync it to a cluster afterward so the deployed app can read it.">
          Set an app secret
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-4" style={{ maxWidth: 480 }}>
          {!!keysQ.data?.secrets.length && (
            <div className="col gap-1">
              <span
                className="muted"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                }}
              >
                Existing keys
              </span>
              <div className="row gap-2 wrap">
                {keysQ.data.secrets.map((s) => (
                  <span
                    key={s.key}
                    className="mono"
                    style={{
                      fontSize: 12,
                      padding: "3px 8px",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                    }}
                  >
                    {s.key}
                  </span>
                ))}
              </div>
            </div>
          )}

          <Field label="Key" hint="Letters, digits, _, . or -; starts with a letter or underscore.">
            <Input
              className="mono"
              value={key}
              placeholder="DATABASE_URL"
              onChange={(e) => {
                setKey(e.target.value);
                setSavedKey(null);
              }}
            />
          </Field>
          <Field label="Value">
            <Input
              type="password"
              value={value}
              placeholder="••••••••••••"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setValue(e.target.value);
                setSavedKey(null);
              }}
            />
          </Field>

          {err && (
            <span style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
              {err}
            </span>
          )}
          {savedKey && (
            <div
              className="row gap-2"
              style={{ alignItems: "center", fontSize: 12.5, color: "var(--ok, #2f9e44)" }}
            >
              <Icon name="check" size={14} /> Saved <span className="mono">{savedKey}</span>
            </div>
          )}

          <div className="row" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <Btn
              variant="primary"
              icon="lock"
              loading={save.isPending}
              disabled={!canSave}
              onClick={() => save.mutate()}
            >
              Save secret
            </Btn>
          </div>
        </div>
      </Block.Body>
    </Block>
  );
}
