"use client";

/**
 * ChatOps — connect a Microsoft Teams (or Slack) channel so alerts / deploys /
 * security findings post there. Uses an incoming webhook (no OAuth): the user
 * creates one in Teams/Slack, pastes the URL, tests it, and saves.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, Select, Toggle } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type Provider = "teams" | "slack";
type Status = { ok: true; connected: boolean; enabled: boolean; provider: Provider; channel: string | null };

const HELP: Record<Provider, string> = {
  teams: "In Teams: open the channel → ••• → Connectors → Incoming Webhook → Configure → name it → Create → copy the URL. (Or use a Power Automate 'When a webhook request is received' flow.)",
  slack: "In Slack: api.slack.com/apps → your app → Incoming Webhooks → Add New Webhook to Workspace → pick a channel → copy the URL.",
};
const PLACEHOLDER: Record<Provider, string> = {
  teams: "https://yourorg.webhook.office.com/webhookb2/…",
  slack: "https://hooks.slack.com/services/T000/B000/XXXX",
};

export function ChatOpsPanel({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState<Provider>("teams");
  const [url, setUrl] = useState("");
  const [channel, setChannel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const statusQ = useQuery<Status>({ queryKey: ["p", slug, "chatops"], queryFn: () => api.get<Status>(`/projects/${slug}/integrations/chatops`) });
  const s = statusQ.data;
  const invalidate = () => qc.invalidateQueries({ queryKey: ["p", slug, "chatops"] });
  const label = (p: Provider) => (p === "teams" ? "Microsoft Teams" : "Slack");

  const save = useMutation({
    mutationFn: () => api.put<Status>(`/projects/${slug}/integrations/chatops`, { provider, webhookUrl: url.trim(), channel: channel.trim() || undefined, enabled: true }),
    onMutate: () => { setErr(null); setMsg(null); },
    onSuccess: () => { setUrl(""); setMsg(`${label(provider)} connected.`); invalidate(); },
    onError: (e) => setErr(apiErrorMessage(e)),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`/projects/${slug}/integrations/chatops/test`, url.trim() ? { provider, webhookUrl: url.trim() } : {}),
    onMutate: () => { setErr(null); setMsg(null); },
    onSuccess: () => setMsg("Test message sent — check your channel."),
    onError: (e) => setErr(apiErrorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patch<Status>(`/projects/${slug}/integrations/chatops`, { enabled }),
    onSuccess: invalidate,
    onError: (e) => setErr(apiErrorMessage(e)),
  });
  const disconnect = useMutation({
    mutationFn: () => api.del(`/projects/${slug}/integrations/chatops`),
    onSuccess: () => { setMsg("Disconnected."); invalidate(); },
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Post alerts, deploy results and security findings to a Teams/Slack channel — more reliable than email.">
          <span className="row gap-2" style={{ alignItems: "center" }}>
            ChatOps notifications
            {s?.connected && <Badge tone={s.enabled ? "ok" : "default"} withDot>{s.enabled ? `connected · ${label(s.provider)}` : "paused"}</Badge>}
          </span>
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3">
          {s?.connected ? (
            <div className="col gap-3">
              <div className="row gap-3 wrap between" style={{ alignItems: "center" }}>
                <span style={{ fontSize: 13 }}>
                  Connected to <b>{label(s.provider)}</b>{s.channel ? ` · #${s.channel}` : ""}. Alerts and events post there.
                </span>
                <span className="row gap-2" style={{ alignItems: "center" }}>
                  <Toggle checked={s.enabled} onCheckedChange={(v) => toggle.mutate(v)} ariaLabel="Enable ChatOps" />
                  <span style={{ fontSize: 12.5 }}>{s.enabled ? "On" : "Off"}</span>
                </span>
              </div>
              <div className="row gap-2 wrap">
                <Btn variant="outline" size="sm" icon="check" loading={test.isPending} onClick={() => test.mutate()}>Send test</Btn>
                <Btn variant="ghost" size="sm" icon="trash" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</Btn>
              </div>
            </div>
          ) : (
            <div className="col gap-3" style={{ maxWidth: 600 }}>
              <div className="row gap-3 wrap">
                <div style={{ minWidth: 180 }}>
                  <Field label="Chat tool">
                    <Select value={provider} onValueChange={(v) => setProvider(v as Provider)} ariaLabel="Provider"
                      options={[{ value: "teams", label: "Microsoft Teams" }, { value: "slack", label: "Slack" }]} />
                  </Field>
                </div>
                <div style={{ minWidth: 180 }}>
                  <Field label="Channel name (optional)"><Input value={channel} placeholder="alerts" onChange={(e) => setChannel(e.target.value)} /></Field>
                </div>
              </div>
              <Field label={`${label(provider)} incoming webhook URL`} hint={HELP[provider]}>
                <Input value={url} placeholder={PLACEHOLDER[provider]} onChange={(e) => setUrl(e.target.value)} />
              </Field>
              <div className="row gap-2 wrap">
                <Btn variant="outline" icon="check" loading={test.isPending} disabled={!url.trim() || test.isPending} onClick={() => test.mutate()}>Send test</Btn>
                <Btn variant="primary" icon="link" loading={save.isPending} disabled={!url.trim() || save.isPending} onClick={() => save.mutate()}>Connect</Btn>
              </div>
            </div>
          )}

          {msg && <span style={{ fontSize: 12.5, color: "var(--ok, #30a46c)" }}>✅ {msg}</span>}
          {err && <span style={{ fontSize: 12.5, color: "var(--danger, #e5484d)" }}>❌ {err}</span>}
        </div>
      </Block.Body>
    </Block>
  );
}
