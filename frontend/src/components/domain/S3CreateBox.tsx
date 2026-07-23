"use client";

/**
 * S3 bucket creation wizard, embedded in chat via the ```s3-create``` fence.
 * Same paged-wizard UX as Ec2CreateBox / VpcCreateBox. Ends with an inline
 * ApprovalCard once the /aws/s3 endpoint returns an approvalId.
 */
import { useEffect, useMemo, useState } from "react";
import { Badge, Block, Btn, Field, Input, Select, type SelectOption } from "@/components/ui";
import { ApprovalCard } from "@/components/domain/ApprovalCard";
import { useProjectEnvs } from "@/hooks/queries/project";
import { useSubmitS3, useS3NameAvailability } from "@/hooks/queries/network";

// Shared across every AWS picker in the app — see lib/aws-regions.ts.
import { AWS_REGIONS } from "@/lib/aws-regions";

const ENCRYPTION_OPTIONS: SelectOption[] = [
  { value: "AES256", label: "SSE-S3 (AES256) — free, AWS-managed" },
  { value: "aws:kms", label: "SSE-KMS (AWS-managed key) — audit trail via KMS" },
];
const VERSIONING_OPTIONS: SelectOption[] = [
  { value: "on", label: "On — object edits keep prior versions" },
  { value: "off", label: "Off — overwrites lose history" },
];
const EXPIRE_OPTIONS: SelectOption[] = [
  { value: "never", label: "Never" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "365 days" },
];
const SUFFIX_OPTIONS: SelectOption[] = [
  { value: "no", label: "No — use my name as-is" },
  { value: "yes", label: "Yes — appends 6 random hex chars to dodge global name collisions" },
];

type Answers = {
  name: string;
  region: string;
  envKey: string;
  encryptionMode: string;
  versioning: string;
  expire: string;
  suffix: string;
};

const PAGE_TITLES = ["Name & region", "Data protection", "Review"];

// AWS's exact bucket-name rules — 3-63 chars, lowercase alphanumerics +
// dashes + dots, must start+end alphanumeric, no consecutive dots, no
// IP-address shape. Same set the server-side validateBucketName enforces.
function validateBucketName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Required.";
  if (n.length < 3 || n.length > 63) return "3–63 characters.";
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(n))
    return "Lowercase letters, digits, dashes or dots. Must start and end with a letter or digit.";
  if (/\.\./.test(n)) return "Cannot contain consecutive dots.";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(n)) return "Cannot look like an IP address.";
  return null;
}

export function S3CreateBox({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const submit = useSubmitS3(slug);

  const [answers, setAnswers] = useState<Answers>({
    name: "my-bucket",
    region: "us-east-1",
    envKey: "",
    encryptionMode: "AES256",
    versioning: "on",
    expire: "90",
    suffix: "no",
  });
  const [pageIdx, setPageIdx] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    approvalId: string;
    repoPath: string;
    repoFullName: string;
  } | null>(null);

  useEffect(() => {
    if (answers.envKey || !envs?.length) return;
    setAnswers((a) => ({ ...a, envKey: envs[0]!.key }));
  }, [envs, answers.envKey]);

  // Live availability check on the bucket name. Debounced inside the hook.
  // Skipped by the hook itself when the trimmed name is <3 chars.
  const nameCheck = useS3NameAvailability(slug, answers.name.trim());
  const nameAvailability = nameCheck.data;

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({
    value: e.key,
    label: e.name || e.key,
  }));
  const regionOptions: SelectOption[] = useMemo(
    () => AWS_REGIONS.map((r) => ({ value: r, label: r })),
    [],
  );

  const errors: Partial<Record<keyof Answers, string>> = {};
  if (pageIdx === 0) {
    const err = validateBucketName(answers.name);
    if (err) errors.name = err;
    // Block Next if AWS confirmed the name is already taken. "unknown" and
    // "checking still in flight" are treated as OK — we don't want a
    // transient AWS hiccup or the user's own account not being connected to
    // block them from proceeding.
    else if (nameAvailability?.status === "taken") errors.name = nameAvailability.message;
    if (!answers.region) errors.region = "Pick a region.";
    if (!answers.envKey) errors.envKey = "Pick an env.";
  }
  const pageHasError = Object.keys(errors).length > 0;
  const onReview = pageIdx === PAGE_TITLES.length - 1;

  function next() {
    if (pageHasError) return;
    setPageIdx((i) => Math.min(PAGE_TITLES.length - 1, i + 1));
  }
  function back() {
    setPageIdx((i) => Math.max(0, i - 1));
  }

  async function handleCreate() {
    setServerError(null);
    try {
      const res = await submit.mutateAsync({
        name: answers.name.trim(),
        envKey: answers.envKey,
        region: answers.region,
        encryptionMode: answers.encryptionMode as "AES256" | "aws:kms",
        versioning: answers.versioning === "on",
        noncurrentVersionExpirationDays:
          answers.expire === "never" ? undefined : Number(answers.expire),
        addRandomSuffix: answers.suffix === "yes",
      });
      if (res.approvalId) {
        setResult({
          approvalId: res.approvalId,
          repoPath: res.repoPath ?? "",
          repoFullName: res.repoFullName ?? "",
        });
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "S3 submit failed.");
    }
  }

  if (result) {
    return (
      <Block>
        <Block.Header>
          <Block.Title
            sub={`Files committed to ${result.repoFullName}/${result.repoPath}. Approve below to run terraform apply.`}
          >
            S3 bucket submitted — pending approval
          </Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="col gap-3">
            <ApprovalCard slug={slug} approvalId={result.approvalId} />
          </div>
        </Block.Body>
      </Block>
    );
  }

  const totalSteps = PAGE_TITLES.length;
  const stepLabel = `Step ${pageIdx + 1} of ${totalSteps} · ${PAGE_TITLES[pageIdx]}`;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Console-style S3 bucket creation. Public access blocked, encryption on, versioning on by default.">
          Create S3 bucket
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-4" style={{ maxWidth: 620 }}>
          <div className="row gap-2" style={{ alignItems: "center" }}>
            {Array.from({ length: totalSteps }).map((_, i) => (
              <span
                key={i}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background: i <= pageIdx ? "var(--accent, #5b8cff)" : "var(--surface-3, #00000018)",
                }}
              />
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
            {stepLabel}
          </span>

          {pageIdx === 0 && (
            <div className="col gap-3">
              <Field
                label="Bucket name"
                required
                hint="3–63 lowercase chars, dashes/dots. GLOBALLY unique across all of AWS."
                error={errors.name}
              >
                <Input
                  value={answers.name}
                  onChange={(e) => setAnswers((a) => ({ ...a, name: e.target.value }))}
                  className="mono"
                />
              </Field>
              {/* Live availability badge — shows only after 3+ chars and the
                  debounced probe has finished. Neutral badge for "unknown"
                  (transient AWS error or no AWS connected); green for
                  "available"; red for "taken". Skipped entirely for names
                  that fail format validation — the field's own error already
                  covers that case. */}
              {answers.name.trim().length >= 3 &&
                validateBucketName(answers.name) === null &&
                (nameCheck.isFetching ? (
                  <div className="row gap-2" style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                    <span>Checking availability…</span>
                  </div>
                ) : nameAvailability?.status === "available" ? (
                  <div className="row gap-2" style={{ fontSize: 12.5 }}>
                    <Badge tone="ok">Available</Badge>
                    <span className="muted">{nameAvailability.message}</span>
                  </div>
                ) : nameAvailability?.status === "taken" ? (
                  <div className="row gap-2" style={{ fontSize: 12.5 }}>
                    <Badge tone="danger">Taken</Badge>
                    <span className="muted">{nameAvailability.message}</span>
                  </div>
                ) : nameAvailability?.status === "unknown" ? (
                  <div className="row gap-2" style={{ fontSize: 12.5 }}>
                    <Badge tone="warn">Can&apos;t verify</Badge>
                    <span className="muted">{nameAvailability.message}</span>
                  </div>
                ) : null)}
              <Field label="Region" required error={errors.region}>
                <Select
                  options={regionOptions}
                  value={answers.region}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, region: v }))}
                  ariaLabel="Region"
                />
              </Field>
              <Field label="Environment" required error={errors.envKey}>
                <Select
                  options={envOptions}
                  value={answers.envKey}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, envKey: v }))}
                  ariaLabel="Environment"
                  placeholder="Pick an env…"
                />
              </Field>
              <div className="row gap-2 wrap" style={{ fontSize: 12 }}>
                <Badge tone="ok">Public access blocked</Badge>
                <Badge tone="ok">SSE encryption on</Badge>
                <Badge tone="ok">Versioning on</Badge>
              </div>
            </div>
          )}

          {pageIdx === 1 && (
            <div className="col gap-3">
              <Field label="Encryption" required>
                <Select
                  options={ENCRYPTION_OPTIONS}
                  value={answers.encryptionMode}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, encryptionMode: v }))}
                  ariaLabel="Encryption"
                />
              </Field>
              <Field label="Object versioning" required>
                <Select
                  options={VERSIONING_OPTIONS}
                  value={answers.versioning}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, versioning: v }))}
                  ariaLabel="Versioning"
                />
              </Field>
              <Field
                label="Expire noncurrent versions"
                hint="Caps storage cost when versioning is on."
              >
                <Select
                  options={EXPIRE_OPTIONS}
                  value={answers.expire}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, expire: v }))}
                  ariaLabel="Expire noncurrent versions"
                />
              </Field>
              <Field
                label="Add random name suffix"
                hint="Helps sidestep S3's global-name-collision problem for generic names."
              >
                <Select
                  options={SUFFIX_OPTIONS}
                  value={answers.suffix}
                  onValueChange={(v) => setAnswers((a) => ({ ...a, suffix: v }))}
                  ariaLabel="Random suffix"
                />
              </Field>
            </div>
          )}

          {onReview && (
            <div className="col gap-3">
              <div
                className="col gap-1"
                style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}
              >
                <ReviewRow label="Bucket name" value={answers.name} />
                <ReviewRow label="Region" value={answers.region} />
                <ReviewRow
                  label="Environment"
                  value={envs?.find((e) => e.key === answers.envKey)?.name ?? answers.envKey}
                />
                <ReviewRow
                  label="Encryption"
                  value={
                    ENCRYPTION_OPTIONS.find((o) => o.value === answers.encryptionMode)?.label ??
                    answers.encryptionMode
                  }
                />
                <ReviewRow
                  label="Versioning"
                  value={answers.versioning === "on" ? "Enabled" : "Suspended"}
                />
                <ReviewRow
                  label="Expire noncurrent versions"
                  value={answers.expire === "never" ? "Never" : `After ${answers.expire} days`}
                />
                <ReviewRow
                  label="Random suffix"
                  value={answers.suffix === "yes" ? "Yes" : "No"}
                />
                <ReviewRow label="Public access" value="Blocked (all four flags)" />
              </div>
              {serverError && (
                <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
                  {serverError}
                </p>
              )}
            </div>
          )}

          <div className="row gap-2" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <Btn variant="ghost" onClick={back} disabled={pageIdx === 0 || submit.isPending}>
              Back
            </Btn>
            {onReview ? (
              <Btn
                variant="primary"
                icon="plus"
                loading={submit.isPending}
                onClick={handleCreate}
              >
                Create bucket
              </Btn>
            ) : (
              <Btn variant="primary" onClick={next} disabled={pageHasError}>
                Next
              </Btn>
            )}
          </div>
        </div>
      </Block.Body>
    </Block>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between" style={{ gap: 12, fontSize: 13 }}>
      <span className="muted">{label}</span>
      <span style={{ fontWeight: 600, textAlign: "right", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}
