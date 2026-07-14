"use client";

/**
 * GCP context panel (Cloud providers page) — pick the GCP project + region for
 * THIS workspace project. Saved per-project; the agent reads the same saved
 * context before running GCP commands (so it targets the right project).
 */
import { useEffect, useState } from "react";
import { Badge, Block, Btn, Field, Icon, Select } from "@/components/ui";
import { useGcpContext, useSaveGcpContext } from "@/hooks/queries/gcp";

const REGION_OPTS = [
  "us-central1",
  "us-east1",
  "us-west1",
  "europe-west1",
  "europe-west2",
  "asia-south1",
  "asia-southeast1",
  "australia-southeast1",
].map((r) => ({ value: r, label: r }));

export function GcpContextSection({ slug }: { slug: string }) {
  const { data, isLoading } = useGcpContext(slug);
  const save = useSaveGcpContext(slug);

  const [proj, setProj] = useState("");
  const [region, setRegion] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data?.connected) {
      setProj(data.gcpProjectId ?? "");
      setRegion(data.region ?? "");
      setDirty(false);
    }
  }, [data]);

  if (!isLoading && (!data || !data.connected)) return null;

  const projOpts = (data?.projects ?? []).map((p) => ({
    value: p.projectId,
    label: `${p.name || p.projectId} (${p.projectId})`,
  }));

  async function onSave() {
    await save.mutateAsync({ gcpProjectId: proj || undefined, region: region || undefined });
    setDirty(false);
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="The GCP project and region the agent targets for Google Cloud commands in this project.">
          <span className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="cloud" /> GCP context
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
                Couldn&apos;t reach GCP: {data.authError}
              </div>
            )}

            <Field label="GCP project" hint="Which Google Cloud project to work in.">
              {projOpts.length > 0 ? (
                <Select
                  value={proj}
                  onValueChange={(v) => {
                    setProj(v);
                    setDirty(true);
                  }}
                  options={projOpts}
                  placeholder="Pick a GCP project"
                />
              ) : (
                <div className="faint" style={{ fontSize: 12 }}>
                  No projects visible to this account.
                </div>
              )}
            </Field>

            <div style={{ maxWidth: 260 }}>
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
          </div>
        )}
      </Block.Body>
    </Block>
  );
}
