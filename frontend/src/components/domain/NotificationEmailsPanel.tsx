"use client";

/**
 * Notification emails — extra addresses (beyond project members) that get alert
 * emails. The reliable notification channel when chat webhooks aren't available.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type Resp = { ok: true; emails: string[] };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function NotificationEmailsPanel({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const [emails, setEmails] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery<Resp>({ queryKey: ["p", slug, "alert-emails"], queryFn: () => api.get<Resp>(`/projects/${slug}/alert-emails`) });
  useEffect(() => { if (q.data?.emails) setEmails(q.data.emails); }, [q.data]);

  const save = useMutation({
    mutationFn: (list: string[]) => api.put<Resp>(`/projects/${slug}/alert-emails`, { emails: list }),
    onMutate: () => { setErr(null); setMsg(null); },
    onSuccess: (r) => { setEmails(r.emails); setMsg("Saved."); qc.invalidateQueries({ queryKey: ["p", slug, "alert-emails"] }); },
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  const add = () => {
    const v = input.trim().toLowerCase();
    if (!EMAIL_RE.test(v)) { setErr("Enter a valid email address."); return; }
    if (emails.includes(v)) { setInput(""); return; }
    const next = [...emails, v];
    setEmails(next); setInput(""); save.mutate(next);
  };
  const remove = (e: string) => { const next = emails.filter((x) => x !== e); setEmails(next); save.mutate(next); };

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Extra addresses that get an email whenever an alert fires (on top of project members). The reliable channel when chat webhooks aren't available.">
          Notification emails
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3">
          <div className="row gap-2 wrap">
            {emails.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>No extra recipients yet — project members still get alerts.</span>}
            {emails.map((e) => (
              <span key={e} className="row gap-1" style={{ alignItems: "center", background: "var(--surface-2, #0000000a)", borderRadius: 6, padding: "3px 8px", fontSize: 12.5 }}>
                {e}
                <Btn variant="ghost" size="sm" icon="x" aria-label={`Remove ${e}`} onClick={() => remove(e)} />
              </span>
            ))}
          </div>
          <div className="row gap-2 wrap" style={{ alignItems: "flex-end", maxWidth: 480 }}>
            <div style={{ minWidth: 240, flex: 1 }}>
              <Field label="Add an email">
                <Input value={input} placeholder="alerts@example.com" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
              </Field>
            </div>
            <Btn variant="primary" icon="plus" loading={save.isPending} disabled={!input.trim() || save.isPending} onClick={add}>Add</Btn>
          </div>
          {msg && <span style={{ fontSize: 12, color: "var(--ok, #30a46c)" }}>✅ {msg}</span>}
          {err && <span style={{ fontSize: 12, color: "var(--danger, #e5484d)" }}>❌ {err}</span>}
        </div>
      </Block.Body>
    </Block>
  );
}
