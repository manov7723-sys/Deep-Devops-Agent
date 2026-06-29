/**
 * "Security scan (Trivy)" automation — runs the official Trivy container
 * server-side against a connected repo and returns parsed vulnerability
 * findings for in-app display.
 *
 * WHY DOCKER: Trivy is a build-time scanner, not a cloud API, so it can't be
 * called over REST. Rather than require a host install, we invoke the pinned
 * `aquasec/trivy` image via the Docker CLI (the one host dependency, the same
 * Docker that already runs the local Postgres). For private repos the GitHub
 * token is embedded in the clone URL so Trivy's `repo` mode can fetch it.
 *
 * The separate `generateTrivyWorkflow()` template (in @/lib/ci/templates) emits
 * a CI workflow so scanning also runs on every push/PR.
 */
import { execFile } from "node:child_process";
import { resolveAttachedRepo } from "./repo-analyze";

const TRIVY_IMAGE = "aquasec/trivy:latest";
const SCAN_TIMEOUT_MS = 5 * 60 * 1000; // hard ceiling for the whole docker run
const MAX_FINDINGS = 300; // cap the payload returned to the client

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

/** vuln = vulnerable dependency · misconfig = IaC/Dockerfile misconfiguration · secret = hardcoded secret. */
export type FindingClass = "vuln" | "misconfig" | "secret";

export type TrivyFinding = {
  class: FindingClass;
  target: string;
  targetType: string;
  pkgName: string; // vuln: library · misconfig: "" · secret: rule category
  vulnerabilityId: string; // CVE / AVD-ID / secret rule id
  severity: Severity;
  status: string;
  installedVersion: string;
  fixedVersion: string;
  location: string; // misconfig/secret: line reference · vuln: ""
  title: string;
  primaryUrl: string;
};

export type TrivyScanResult =
  | {
      ok: true;
      artifact: string;
      total: number;
      truncated: boolean;
      counts: Record<Severity, number>;
      findings: TrivyFinding[];
    }
  | { ok: false; error: string };

const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];

type RawVuln = {
  PkgName?: string;
  VulnerabilityID?: string;
  Severity?: string;
  Status?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Title?: string;
  PrimaryURL?: string;
};
type RawMisconfig = {
  ID?: string;
  AVDID?: string;
  Title?: string;
  Description?: string;
  Message?: string;
  Severity?: string;
  Status?: string;
  PrimaryURL?: string;
  CauseMetadata?: { StartLine?: number };
};
type RawSecret = {
  RuleID?: string;
  Category?: string;
  Severity?: string;
  Title?: string;
  StartLine?: number;
};
type RawResult = {
  Target?: string;
  Type?: string;
  Vulnerabilities?: RawVuln[] | null;
  Misconfigurations?: RawMisconfig[] | null;
  Secrets?: RawSecret[] | null;
};
type RawReport = { ArtifactName?: string; Results?: RawResult[] | null };

function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      { timeout: SCAN_TIMEOUT_MS, maxBuffer: 128 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // Trivy exits 0 here (we don't set --exit-code), so any error is a real
        // process/spawn failure (docker missing, timeout, image pull failure).
        if (err) {
          reject(Object.assign(err, { stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/** Run Trivy against a connected repo and return parsed findings. */
export async function scanRepoWithTrivy(projectId: string, repoFullName: string): Promise<TrivyScanResult> {
  const resolved = await resolveAttachedRepo(projectId, repoFullName);
  if (!resolved.ok) return resolved;
  const { fullName, accessToken } = resolved.repo;

  // Embed the token so Trivy's repo scanner can clone private repos. Falls back
  // to an anonymous URL if no token (public repos).
  const cloneUrl = accessToken
    ? `https://x-access-token:${accessToken}@github.com/${fullName}.git`
    : `https://github.com/${fullName}.git`;

  let stdout: string;
  try {
    const res = await runDocker([
      "run", "--rm",
      TRIVY_IMAGE,
      "repo",
      "--scanners", "vuln,secret,misconfig",
      "--format", "json",
      "--quiet",
      "--timeout", "4m",
      cloneUrl,
    ]);
    stdout = res.stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.code === "ENOENT") {
      return { ok: false, error: "Docker isn't available on the server — the Trivy scan needs Docker to run." };
    }
    if (err.killed) {
      return { ok: false, error: "The scan timed out. The repository may be too large to scan inline." };
    }
    const detail = (err.stderr || err.message || "").trim().split("\n").slice(-1)[0] || "unknown error";
    return { ok: false, error: `Trivy scan failed: ${detail}` };
  }

  let report: RawReport;
  try {
    report = JSON.parse(stdout) as RawReport;
  } catch {
    return { ok: false, error: "Couldn't parse the Trivy output." };
  }

  const sev = (s?: string): Severity => (SEVERITY_ORDER.includes(s as Severity) ? (s as Severity) : "UNKNOWN");
  const clip = (s: string) => (s.length > 180 ? s.slice(0, 177) + "…" : s);

  // Trivy can emit the same finding several times (e.g. one misconfig per
  // resource occurrence in a .tf file). Collapse exact duplicates so the table
  // and counts reflect distinct issues, not repeats.
  const seen = new Set<string>();
  const all: TrivyFinding[] = [];
  const add = (f: TrivyFinding) => {
    const key = `${f.class}|${f.target}|${f.vulnerabilityId}|${f.pkgName}|${f.installedVersion}|${f.location}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push(f);
  };

  for (const r of report.Results ?? []) {
    const target = r.Target ?? "";
    const targetType = r.Type ?? "";

    for (const v of r.Vulnerabilities ?? []) {
      add({
        class: "vuln",
        target, targetType,
        pkgName: v.PkgName ?? "",
        vulnerabilityId: v.VulnerabilityID ?? "",
        severity: sev(v.Severity),
        status: v.Status ?? "",
        installedVersion: v.InstalledVersion ?? "",
        fixedVersion: v.FixedVersion ?? "",
        location: "",
        title: clip(v.Title ?? ""),
        primaryUrl: v.PrimaryURL ?? "",
      });
    }

    for (const m of r.Misconfigurations ?? []) {
      // Only surface failures, not passed checks.
      if (m.Status && m.Status.toUpperCase() === "PASS") continue;
      add({
        class: "misconfig",
        target, targetType,
        pkgName: "",
        vulnerabilityId: m.AVDID || m.ID || "",
        severity: sev(m.Severity),
        status: m.Status ?? "",
        installedVersion: "",
        fixedVersion: "",
        location: m.CauseMetadata?.StartLine ? `line ${m.CauseMetadata.StartLine}` : "",
        title: clip(m.Title || m.Message || m.Description || ""),
        primaryUrl: m.PrimaryURL ?? "",
      });
    }

    for (const s of r.Secrets ?? []) {
      add({
        class: "secret",
        target, targetType,
        pkgName: s.Category ?? "",
        vulnerabilityId: s.RuleID ?? "",
        severity: sev(s.Severity),
        status: "",
        installedVersion: "",
        fixedVersion: "",
        location: s.StartLine ? `line ${s.StartLine}` : "",
        title: clip(s.Title ?? ""),
        primaryUrl: "",
      });
    }
  }

  // Count by severity from the de-duplicated set so the summary matches the table.
  const counts: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const f of all) counts[f.severity]++;

  // Most severe first, so the capped list shows what matters.
  all.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const findings = all.slice(0, MAX_FINDINGS);

  return {
    ok: true,
    // Never surface the clone URL — it embeds the access token. Report the
    // plain repo name instead.
    artifact: fullName,
    total: all.length,
    truncated: all.length > findings.length,
    counts,
    findings,
  };
}
