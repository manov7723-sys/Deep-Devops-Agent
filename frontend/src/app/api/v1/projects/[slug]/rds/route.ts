import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import {
  buildRdsTerraform,
  RDS_DEFAULTS,
  RDS_INSTANCE_CLASSES,
  RDS_POSTGRES_VERSIONS,
  RDS_MYSQL_VERSIONS,
  RDS_STORAGE_TYPES,
  RDS_MONITORING_INTERVALS,
  RDS_LOG_EXPORTS,
  type RdsSpec,
} from "@/lib/devops/rds";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * RDS creation wizard — options and Terraform generation.
 *
 * Mirrors the EKS/AKS/GKE routes so the shared wizard engine can drive it:
 *   GET  — defaults + option lists
 *   POST — validated answers in, Terraform tree out
 *
 * Live AWS inventory (EKS clusters, VPCs, security groups) is NOT re-fetched
 * here — /aws/clusters, /aws/vpcs and /aws/security-groups already do it, and
 * the wizard engine pulls them through `extraQueries`.
 *
 * The database wizard previously exposed eight fields against the console's
 * forty. The gap mattered because the missing ones are largely IRREVERSIBLE
 * (encryption, KMS key) or needed for production sign-off (Multi-AZ, backup
 * windows, deletion protection, Performance Insights) — so users created a
 * database here and then reconfigured it by hand, or recreated it entirely.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  return NextResponse.json({
    defaults: RDS_DEFAULTS,
    instanceClasses: RDS_INSTANCE_CLASSES,
    postgresVersions: RDS_POSTGRES_VERSIONS,
    mysqlVersions: RDS_MYSQL_VERSIONS,
    storageTypes: RDS_STORAGE_TYPES,
    monitoringIntervals: RDS_MONITORING_INTERVALS,
    logExports: RDS_LOG_EXPORTS,
  });
}

const Body = z.object({
  envKey: z.string().trim().max(60).optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9-]*$/, "Lowercase letters, digits and hyphens; must start with a letter."),
  region: z.string().trim().min(1),
  engine: z.enum(["postgres", "mysql"]),
  engineVersion: z.string().trim().min(1),
  instanceClass: z.string().trim().min(1),

  allocatedStorage: z.coerce.number().int().min(20).max(65536).default(20),
  maxAllocatedStorage: z.coerce.number().int().min(20).max(65536).default(100),
  storageType: z.enum(["gp3", "gp2", "io1", "io2"]).default("gp3"),
  iops: z.coerce.number().int().min(1000).max(256000).optional(),
  storageThroughput: z.coerce.number().int().min(125).max(4000).optional(),

  storageEncrypted: z.boolean().default(true),
  kmsKeyId: z.string().trim().max(400).optional(),
  iamDatabaseAuthentication: z.boolean().default(false),

  multiAz: z.boolean().default(false),
  backupRetentionDays: z.coerce.number().int().min(0).max(35).default(7),
  backupWindow: z.string().trim().max(20).optional(),
  maintenanceWindow: z.string().trim().max(30).optional(),
  autoMinorVersionUpgrade: z.boolean().default(true),
  deletionProtection: z.boolean().default(true),
  skipFinalSnapshot: z.boolean().default(false),

  performanceInsights: z.boolean().default(false),
  performanceInsightsRetention: z.union([z.literal(7), z.literal(731)]).default(7),
  monitoringInterval: z.union([
    z.literal(0), z.literal(1), z.literal(5), z.literal(10),
    z.literal(15), z.literal(30), z.literal(60),
  ]).default(0),
  enabledCloudwatchLogsExports: z.array(z.string()).default([]),

  eksClusterName: z.string().trim().max(120).optional(),
  vpcId: z.string().trim().max(40).optional(),
  allowSgId: z.string().trim().max(40).optional(),
  publiclyAccessible: z.boolean().default(false),
  allowedCidrs: z.array(z.string()).default([]),
  dbSubnetIds: z.array(z.string().trim().max(40)).max(20).default([]),
  dbSubnetGroupName: z.string().trim().max(255).optional(),

  dbUsername: z.string().trim().min(1).max(40).default("app"),
  initialDbName: z.string().trim().max(60).optional(),
})
  .superRefine((v, ctx) => {
    // io1/io2 bill for provisioned IOPS and will not create without a value.
    if ((v.storageType === "io1" || v.storageType === "io2") && !v.iops) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["iops"],
        message: `Storage type "${v.storageType}" requires a provisioned IOPS value.`,
      });
    }
    if (v.maxAllocatedStorage < v.allocatedStorage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxAllocatedStorage"],
        message: "Storage autoscaling ceiling cannot be below the initial allocated storage.",
      });
    }
    // The generator needs to know where the database lives and what may reach
    // it; without either input it throws at build time with a less clear error.
    if (!v.eksClusterName && !v.vpcId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eksClusterName"],
        message: "Pick the EKS cluster this database serves, or supply a VPC ID directly.",
      });
    }
    // NOTE: deletionProtection + skipFinalSnapshot is deliberately NOT
    // rejected. It looks contradictory but AWS accepts it — protection blocks
    // the destroy until you clear it, and skip-final-snapshot only takes
    // effect once you do. The wizard explains the interaction instead.

    // A DB subnet group needs two subnets in two AZs. The wizard checks the AZ
    // half (it has the inventory); the count is re-checked here because the
    // agent tool posts here too.
    if (!v.dbSubnetGroupName && v.dbSubnetIds.length === 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dbSubnetIds"],
        message:
          "A DB subnet group needs at least two subnets in two different Availability Zones — only one was given.",
      });
    }
  });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const a = parsed.data;

  const spec: RdsSpec = {
    name: a.name,
    region: a.region,
    engine: a.engine,
    engineVersion: a.engineVersion,
    instanceClass: a.instanceClass,
    allocatedStorage: a.allocatedStorage,
    maxAllocatedStorage: a.maxAllocatedStorage,
    storageType: a.storageType,
    iops: a.iops,
    storageThroughput: a.storageThroughput,
    storageEncrypted: a.storageEncrypted,
    kmsKeyId: a.kmsKeyId || undefined,
    iamDatabaseAuthentication: a.iamDatabaseAuthentication,
    multiAz: a.multiAz,
    backupRetentionDays: a.backupRetentionDays,
    backupWindow: a.backupWindow || undefined,
    maintenanceWindow: a.maintenanceWindow || undefined,
    autoMinorVersionUpgrade: a.autoMinorVersionUpgrade,
    deletionProtection: a.deletionProtection,
    skipFinalSnapshot: a.skipFinalSnapshot,
    performanceInsights: a.performanceInsights,
    performanceInsightsRetention: a.performanceInsightsRetention,
    monitoringInterval: a.monitoringInterval,
    enabledCloudwatchLogsExports: a.enabledCloudwatchLogsExports,
    eksClusterName: a.eksClusterName || undefined,
    vpcId: a.vpcId || undefined,
    allowSgId: a.allowSgId || undefined,
    publiclyAccessible: a.publiclyAccessible,
    allowedCidrs: a.allowedCidrs,
    dbSubnetIds: a.dbSubnetIds,
    dbSubnetGroupName: a.dbSubnetGroupName || undefined,
    dbUsername: a.dbUsername,
    initialDbName: a.initialDbName || undefined,
    env: a.envKey,
  };

  let files: Record<string, string>;
  try {
    files = buildRdsTerraform(spec);
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "generate_failed", message: e instanceof Error ? e.message : "Generation failed." },
      { status: 400 },
    );
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "rds.terraform_generated",
    targetType: "rds_instance",
    targetId: `${slug}/${a.name}`,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      region: a.region,
      engine: a.engine,
      version: a.engineVersion,
      instanceClass: a.instanceClass,
      multiAz: a.multiAz,
      publiclyAccessible: a.publiclyAccessible,
    },
  });

  return NextResponse.json({
    ok: true,
    clusterName: a.name, // the wizard engine calls the generated resource this
    location: a.region,
    fileCount: Object.keys(files).length,
    files,
  });
}
