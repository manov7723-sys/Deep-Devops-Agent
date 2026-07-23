/**
 * Append-only audit trail. Writes to `AuditLog` for security-sensitive events
 * (logins, MFA changes, session revokes, password resets, admin actions).
 *
 * Best-effort: failures are logged but never thrown — an audit-write failure
 * must not break the action it's recording (this is a security telemetry
 * channel, not a transactional dependency).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type AuditAction =
  | "auth.signup"
  | "auth.login.success"
  | "auth.login.failure"
  | "auth.logout"
  | "auth.mfa.totp_enrolled"
  | "auth.mfa.totp_verified"
  | "auth.mfa.totp_failed"
  | "auth.mfa.backup_used"
  | "auth.mfa.totp_disabled"
  | "auth.totp_skipped"
  | "auth.backup_codes_regenerated"
  | "auth.password_reset_requested"
  | "auth.password_reset_completed"
  | "auth.session_revoked"
  | "auth.session_revoked_others"
  | "project.created"
  | "project.updated"
  | "project.archived"
  | "project.unarchived"
  | "project.deleted"
  | "project.transferred"
  | "project.member_role_changed"
  | "project.member_removed"
  | "project.invitation_created"
  | "project.invitation_revoked"
  | "project.invitation_accepted"
  | "repo.connected"
  | "repo.disconnected"
  | "repo.attached"
  | "repo.detached"
  | "repo.file_committed"
  | "repo.scanned"
  | "repo.remediation_doc"
  | "deployment.applied"
  | "cloud_provider.created"
  | "cloud_provider.updated"
  | "cloud_provider.removed"
  | "cloud_provider.credentials_set"
  | "cloud_provider.credentials_cleared"
  | "cloud_provider.sp_provisioned"
  | "chat.cleared"
  | "integration.connected"
  | "integration.updated"
  | "integration.disconnected"
  | "auth.oauth.signin"
  | "auth.oauth.signup"
  | "auth.oauth.linked"
  | "auth.oauth.unlinked"
  | "auth.oauth.failed"
  | "env.created"
  | "env.updated"
  | "env.deleted"
  | "env.repo_wired"
  | "env.repo_unwired"
  | "env.cluster_verified"
  | "env.cluster_verify_failed"
  | "env.tf_backend_set"
  | "eks.terraform_generated"
  | "proxmox.vm_terraform_generated"
  | "gke.terraform_generated"
  | "gke.cluster_deleted"
  | "aks.terraform_generated"
  | "azure.tfstate_provisioned"
  | "terraform.run_started"
  | "terraform.run_rerun"
  | "env.cluster_connected"
  | "deployment.triggered"
  | "deployment.rolled_back"
  | "pipeline.patched"
  | "pipeline.triggered"
  | "pipeline.retried"
  | "approval.created"
  | "approval.decided"
  | "alert.created"
  | "alert.patched"
  | "task.created"
  | "task.patched"
  | "task.deleted"
  | "knowledge.created"
  | "knowledge.patched"
  | "knowledge.deleted"
  | "chat.thread_created"
  | "chat.message_posted"
  | "cost.snapshot_recorded"
  | "observability.kpi_created"
  | "observability.target_created"
  | "observability.dashboard_created"
  | "monitoring.installed"
  | "cloudwatch.alarms_configured"
  | "azure_monitor.alarms_configured"
  | "gcp_monitor.alarms_configured"
  | "workload.created"
  | "workload.patched"
  | "workload.deleted"
  | "security_scope.created"
  | "security_scope.deleted"
  | "security_scope.bound"
  | "security_scope.unbound"
  | "billing.plan_created"
  | "billing.addon_created"
  | "billing.checkout_started"
  | "billing.subscription_switched"
  | "billing.portal_opened"
  | "billing.webhook_received"
  | "billing.subscription_synced"
  | "billing.invoice_synced"
  | "billing.payment_method_synced"
  | "admin.user_promoted"
  | "admin.user_demoted"
  | "admin.oauth_config_upserted"
  | "admin.oauth_config_cleared"
  | "admin.settings_patched"
  | "admin.asset_upserted"
  | "admin.env_var_upserted"
  | "admin.system_component_upserted"
  | "admin.agent_created"
  | "admin.agent_patched"
  | "admin.agent_deleted"
  | "admin.model_created"
  | "admin.model_patched"
  | "admin.model_deleted"
  | "admin.mcp_created"
  | "admin.mcp_patched"
  | "admin.mcp_deleted"
  | "admin.mcp_credential_upserted"
  | "admin.tokens_granted";

export type AuditArgs = {
  userId?: string | null;
  projectId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export async function audit(args: AuditArgs): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: args.userId ?? null,
        projectId: args.projectId ?? null,
        action: args.action,
        targetType: args.targetType ?? null,
        targetId: args.targetId ?? null,
        ipAddress: args.ipAddress ?? null,
        userAgent: args.userAgent ?? null,
        metadata: args.metadata ?? undefined,
      },
    });
  } catch (err) {
    console.error(
      `[audit] failed to write ${args.action}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
