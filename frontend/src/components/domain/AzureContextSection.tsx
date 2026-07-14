"use client";

/**
 * Azure context panel (Cloud providers page) — pick the subscription, resource
 * group, region, and cloud environment for THIS project. Saved per-project; the
 * agent reads the same saved context before running Azure commands.
 */
import { useEffect, useState } from "react";
import { Badge, Block, Btn, Field, Icon, Input, Select } from "@/components/ui";
import { useAzureContext, useSaveAzureContext } from "@/hooks/queries/azure";

const REGION_OPTS = [
  "eastus",
  "eastus2",
  "westus",
  "westus2",
  "centralus",
  "westeurope",
  "northeurope",
  "uksouth",
  "southeastasia",
  "eastasia",
  "australiaeast",
].map((r) => ({ value: r, label: r }));

const ENV_OPTS = [
  { value: "AzurePublic", label: "Azure Public" },
  { value: "AzureUSGovernment", label: "Azure Government" },
  { value: "AzureChina", label: "Azure China" },
];

export function AzureContextSection({ slug }: { slug: string }) {
  const { data, isLoading } = useAzureContext(slug);
  const save = useSaveAzureContext(slug);

  const [sub, setSub] = useState("");
  const [rg, setRg] = useState("");
  const [region, setRegion] = useState("");
  const [env, setEnv] = useState("AzurePublic");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data?.connected) {
      setSub(data.subscriptionId ?? "");
      setRg(data.resourceGroup ?? "");
      setRegion(data.region ?? "");
      setEnv(data.cloudEnvironment ?? "AzurePublic");
      setDirty(false);
    }
  }, [data]);

  // Only render for projects that actually have Azure connected.
  if (!isLoading && (!data || !data.connected)) return null;

  const subOpts = (data?.subscriptions ?? []).map((s) => ({
    value: s.subscriptionId,
    label: `${s.displayName} (${s.subscriptionId.slice(0, 8)}…)`,
  }));
  const rgOpts = [
    { value: "", label: "— none / subscription-wide —" },
    ...(data?.resourceGroups ?? []).map((r) => ({
      value: r.name,
      label: `${r.name} (${r.location})`,
    })),
  ];

  async function onSave() {
    await save.mutateAsync({
      subscriptionId: sub || undefined,
      resourceGroup: rg,
      region: region || undefined,
      cloudEnvironment: env as "AzurePublic" | "AzureUSGovernment" | "AzureChina",
    });
    setDirty(false);
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="The subscription, resource group, and region the agent uses for Azure commands in this project.">
          <span className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="cloud" /> Azure context
          </span>
        </Block.Title>
      </Block.Header>
      <Block.Body>
        {isLoading ? (
          <div className="faint" style={{ fontSize: 13 }}>
            Loading…
          </div>
        ) : (
          <div className="col gap-4" style={{ maxWidth: 560 }}>
            {data?.authError && (
              <div style={{ color: "var(--danger)", fontSize: 12 }}>
                Couldn&apos;t reach Azure: {data.authError}
              </div>
            )}

            <Field label="Subscription" hint="Which Azure subscription to work in.">
              {subOpts.length > 0 ? (
                <Select
                  value={sub}
                  onValueChange={(v) => {
                    setSub(v);
                    setDirty(true);
                  }}
                  options={subOpts}
                />
              ) : (
                <Input
                  className="mono"
                  value={sub}
                  onChange={(e) => {
                    setSub(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="subscription id"
                />
              )}
            </Field>

            <Field label="Resource group" hint="Default scope for resource queries & deploys.">
              <Select
                value={rg}
                onValueChange={(v) => {
                  setRg(v);
                  setDirty(true);
                }}
                options={rgOpts}
                placeholder="Pick a resource group"
              />
            </Field>

            <div className="row gap-4 wrap">
              <div style={{ flex: 1, minWidth: 200 }}>
                <Field label="Region" hint="Default region for new resources.">
                  <Select
                    value={region}
                    onValueChange={(v) => {
                      setRegion(v);
                      setDirty(true);
                    }}
                    options={REGION_OPTS}
                    placeholder="Pick a region"
                  />
                </Field>
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <Field label="Cloud environment">
                  <Select
                    value={env}
                    onValueChange={(v) => {
                      setEnv(v);
                      setDirty(true);
                    }}
                    options={ENV_OPTS}
                  />
                </Field>
              </div>
            </div>

            <div className="row gap-3" style={{ alignItems: "center" }}>
              <Btn
                variant="primary"
                icon="check"
                disabled={!dirty}
                loading={save.isPending}
                onClick={onSave}
              >
                Save context
              </Btn>
              {!dirty && data?.connected && <Badge tone="accent">saved</Badge>}
              {save.isError && (
                <span style={{ color: "var(--danger)", fontSize: 12 }}>
                  {(save.error as Error).message}
                </span>
              )}
            </div>

            {env !== "AzurePublic" && (
              <div className="faint" style={{ fontSize: 11.5 }}>
                Note: Government/China endpoints aren&apos;t fully routed yet — listing/auth
                currently use Azure Public URLs.
              </div>
            )}
          </div>
        )}
      </Block.Body>
    </Block>
  );
}
