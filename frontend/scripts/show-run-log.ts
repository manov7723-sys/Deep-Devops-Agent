import { readFileSync } from "node:fs";
import { join } from "node:path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}
async function main() {
  const { prisma } = await import("../src/lib/db/prisma");
  const run = await prisma.tfRun.findFirst({
    where: { envKey: "release" },
    orderBy: { createdAt: "desc" },
    select: { name: true, status: true, stages: true, errorMessage: true },
  });
  console.log(`RUN: ${run!.name}  status=${run!.status}  err=${run!.errorMessage ?? "-"}\n`);
  const stages = (run!.stages as unknown as Array<{ name: string; status: string; logs?: string }>) ?? [];
  for (const s of stages) {
    console.log(`===== stage: ${s.name}  (${s.status}) =====`);
    // Print the TAIL of the log where the auto-heal + retry results live.
    const logs = s.logs ?? "";
    console.log(logs.slice(-3500));
    console.log();
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
