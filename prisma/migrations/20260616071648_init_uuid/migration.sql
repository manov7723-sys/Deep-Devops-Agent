-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('owner', 'developer', 'viewer');

-- CreateEnum
CREATE TYPE "HealthStatus" AS ENUM ('ok', 'warn', 'danger');

-- CreateEnum
CREATE TYPE "CloudKind" AS ENUM ('aws', 'gcp', 'azure', 'cloudflare', 'digitalocean');

-- CreateEnum
CREATE TYPE "ResourceCategory" AS ENUM ('compute', 'network', 'storage', 'data', 'cache', 'security', 'other');

-- CreateEnum
CREATE TYPE "ProvisionedBy" AS ENUM ('terraform', 'kubernetes', 'manual');

-- CreateEnum
CREATE TYPE "PipelineStatus" AS ENUM ('running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "StageStatus" AS ENUM ('ok', 'fail', 'run', 'wait');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('running', 'succeeded', 'failed', 'rolled_back');

-- CreateEnum
CREATE TYPE "ApprovalRisk" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "DiffKind" AS ENUM ('add', 'remove', 'comment');

-- CreateEnum
CREATE TYPE "AlertCategory" AS ENUM ('Security', 'Performance', 'Compliance', 'Reliability');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('open', 'ack', 'resolved');

-- CreateEnum
CREATE TYPE "KnowledgeType" AS ENUM ('Doc', 'Runbook');

-- CreateEnum
CREATE TYPE "IssueVerdict" AS ENUM ('passed', 'needs_changes');

-- CreateEnum
CREATE TYPE "IssueState" AS ENUM ('open', 'review', 'closed', 'reopened');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('user', 'agent');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('ok', 'warn', 'running');

-- CreateEnum
CREATE TYPE "RepoKind" AS ENUM ('Service', 'Frontend', 'Terraform', 'Kubernetes', 'Library', 'Worker');

-- CreateEnum
CREATE TYPE "RepoVisibility" AS ENUM ('private', 'public');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('Free', 'Pro', 'Scale', 'Enterprise');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused');

-- CreateEnum
CREATE TYPE "AddonStatus" AS ENUM ('active', 'cancelled', 'pending');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'open', 'paid', 'void', 'uncollectible');

-- CreateEnum
CREATE TYPE "ModelProvider" AS ENUM ('Anthropic', 'OpenAI', 'Self-hosted', 'Google');

-- CreateEnum
CREATE TYPE "McpStatus" AS ENUM ('ok', 'warn', 'down');

-- CreateEnum
CREATE TYPE "SecurityScopeKind" AS ENUM ('security_group', 'iam_role', 'kms_key', 'secret_store', 'network_policy');

-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('github', 'google');

-- CreateEnum
CREATE TYPE "AccountRole" AS ENUM ('owner', 'admin', 'developer', 'viewer');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('month', 'year', 'forever', 'none');

-- CreateEnum
CREATE TYPE "CardBrand" AS ENUM ('visa', 'mastercard', 'amex', 'discover', 'diners', 'jcb', 'unionpay', 'unknown');

-- CreateEnum
CREATE TYPE "TotpAlgorithm" AS ENUM ('SHA1', 'SHA256', 'SHA512');

-- CreateEnum
CREATE TYPE "McpAuthType" AS ENUM ('none', 'oauth', 'credential');

-- CreateEnum
CREATE TYPE "NotifKind" AS ENUM ('approval', 'deployment', 'alert', 'billing', 'member', 'system');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('pending_mfa', 'active', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "MagicLinkPurpose" AS ENUM ('login', 'password_reset', 'email_verify', 'invite');

-- CreateEnum
CREATE TYPE "CheckoutMode" AS ENUM ('subscription', 'setup', 'payment');

-- CreateEnum
CREATE TYPE "CheckoutStatus" AS ENUM ('open', 'complete', 'expired');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('pending', 'accepted', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "KnowledgeSource" AS ENUM ('written', 'upload');

-- CreateEnum
CREATE TYPE "KnowledgeIngestStatus" AS ENUM ('pending', 'processing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "IntegrationAuthType" AS ENUM ('oauth', 'credential');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('disconnected', 'connected', 'error', 'expired');

-- CreateEnum
CREATE TYPE "TargetStatus" AS ENUM ('up', 'down');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "avatarUrl" TEXT,
    "jobTitle" TEXT,
    "timezone" TEXT,
    "passwordHash" TEXT,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "role" "AccountRole" NOT NULL DEFAULT 'owner',
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emailVerifiedAt" TIMESTAMP(3),
    "lastPasswordChangedAt" TIMESTAMP(3),
    "termsAcceptedAt" TIMESTAMP(3),
    "stripeCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "category" "NotifKind",
    "icon" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "linkHref" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "batchId" TEXT,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'pending_mfa',
    "forcedTotpSetup" BOOLEAN NOT NULL DEFAULT false,
    "rememberMe" BOOLEAN NOT NULL DEFAULT false,
    "mfaSatisfiedAt" TIMESTAMP(3),
    "deviceLabel" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MagicLink" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "MagicLinkPurpose" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "requestedIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MagicLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "accessTokenRef" TEXT,
    "refreshTokenRef" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TotpCredential" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "secretRef" TEXT NOT NULL,
    "label" TEXT,
    "algorithm" "TotpAlgorithm" NOT NULL DEFAULT 'SHA1',
    "digits" INTEGER NOT NULL DEFAULT 6,
    "period" INTEGER NOT NULL DEFAULT 30,
    "confirmedAt" TIMESTAMP(3),
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "TotpCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" UUID NOT NULL,
    "tier" "PlanTier" NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER,
    "isCustomPrice" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "period" "BillingPeriod" NOT NULL DEFAULT 'month',
    "popular" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "stripeProductId" TEXT,
    "stripePriceId" TEXT,
    "projectLimit" INTEGER,
    "envLimit" INTEGER,
    "seatLimit" INTEGER,
    "agentTier" TEXT,
    "highlights" TEXT[],

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'incomplete',
    "basePriceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "stripeSubscriptionId" TEXT,
    "stripePriceId" TEXT,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "renewsLabel" TEXT,
    "trialEndsAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "paymentMethodId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stripePaymentMethodId" TEXT NOT NULL,
    "brand" "CardBrand" NOT NULL,
    "last4" TEXT NOT NULL,
    "expMonth" INTEGER NOT NULL,
    "expYear" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Addon" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "tokenGrant" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "stripeProductId" TEXT,
    "stripePriceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Addon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionAddon" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "addonId" UUID,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "status" "AddonStatus" NOT NULL DEFAULT 'active',
    "stripeSubscriptionItemId" TEXT,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "SubscriptionAddon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "stripeInvoiceId" TEXT,
    "number" TEXT,
    "userId" UUID NOT NULL,
    "subscriptionId" UUID,
    "customerName" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" "InvoiceStatus" NOT NULL,
    "hostedInvoiceUrl" TEXT,
    "pdfUrl" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Usage" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "agentRunsUsed" INTEGER NOT NULL DEFAULT 0,
    "agentRunsLimit" INTEGER,
    "deploysUsed" INTEGER NOT NULL DEFAULT 0,
    "deploysLimit" INTEGER,
    "seatsUsed" INTEGER NOT NULL DEFAULT 0,
    "seatsLimit" INTEGER,
    "envsUsed" INTEGER NOT NULL DEFAULT 0,
    "envsLimit" INTEGER,
    "tokensUsed" BIGINT NOT NULL DEFAULT 0,
    "tokensGranted" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "Usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageSample" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "tokens" INTEGER NOT NULL,

    CONSTRAINT "UsageSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "apiVersion" TEXT,
    "payload" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckoutSession" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "mode" "CheckoutMode" NOT NULL,
    "status" "CheckoutStatus" NOT NULL DEFAULT 'open',
    "purpose" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "colorHue" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "health" "HealthStatus" NOT NULL DEFAULT 'ok',
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "ProjectRole" NOT NULL DEFAULT 'viewer',
    "invitedById" UUID,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectInvitation" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "ProjectRole" NOT NULL DEFAULT 'viewer',
    "status" "InvitationStatus" NOT NULL DEFAULT 'pending',
    "invitedById" UUID NOT NULL,
    "acceptedUserId" UUID,
    "magicLinkId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSetting" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "autoDeployNonProd" BOOLEAN NOT NULL DEFAULT true,
    "requireApprovalRelease" BOOLEAN NOT NULL DEFAULT true,
    "defaultModelId" UUID,

    CONSTRAINT "ProjectSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repo" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "fullName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "lang" TEXT NOT NULL,
    "kind" "RepoKind" NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "visibility" "RepoVisibility" NOT NULL DEFAULT 'private',
    "openIssues" INTEGER NOT NULL DEFAULT 0,
    "openPrs" INTEGER NOT NULL DEFAULT 0,
    "lastCommitSha" TEXT,
    "lastCommitAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Repo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectRepo" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "repoId" UUID NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectRepo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvRepo" (
    "id" UUID NOT NULL,
    "envId" UUID NOT NULL,
    "repoId" UUID NOT NULL,
    "branch" TEXT NOT NULL,
    "autoDeploy" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvRepo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Env" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "cloudProviderId" UUID,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "isProduction" BOOLEAN NOT NULL DEFAULT false,
    "autoDeploy" BOOLEAN NOT NULL DEFAULT false,
    "region" TEXT,
    "terraformWorkspace" TEXT,
    "promotionRank" INTEGER NOT NULL DEFAULT 0,
    "currentDeploymentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Env_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" UUID NOT NULL,
    "envId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'running',
    "triggeredById" UUID,
    "triggeredByAgentId" UUID,
    "rollbackOfId" UUID,
    "tfStateRef" TEXT,
    "tfPlanRef" TEXT,
    "infraSnapshot" JSONB,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentRepo" (
    "id" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "repoId" UUID NOT NULL,
    "sha" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentRepo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedResource" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "envId" UUID NOT NULL,
    "cloudProviderId" UUID,
    "name" TEXT NOT NULL,
    "category" "ResourceCategory" NOT NULL,
    "type" TEXT NOT NULL,
    "provisionedBy" "ProvisionedBy" NOT NULL DEFAULT 'terraform',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "region" TEXT,
    "status" "HealthStatus" NOT NULL DEFAULT 'ok',
    "cpuPct" INTEGER,
    "memPct" INTEGER,
    "replicasReady" INTEGER,
    "replicasDesired" INTEGER,
    "attributes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pipeline" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "envId" UUID NOT NULL,
    "repoId" UUID NOT NULL,
    "branch" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "status" "PipelineStatus" NOT NULL DEFAULT 'running',
    "triggeredById" UUID,
    "triggeredByAgentId" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "retryOfId" UUID,
    "deploymentId" UUID,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineStage" (
    "id" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "status" "StageStatus" NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "envId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "requestedByAgentId" UUID,
    "repoId" UUID,
    "changesSummary" TEXT,
    "risk" "ApprovalRisk" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" UUID,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDiff" (
    "id" UUID NOT NULL,
    "approvalId" UUID NOT NULL,
    "kind" "DiffKind" NOT NULL,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "ApprovalDiff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "actorUserId" UUID,
    "actorAgentId" UUID,
    "actorLabel" TEXT,
    "action" TEXT NOT NULL,
    "targetLabel" TEXT NOT NULL,
    "targetType" TEXT,
    "envId" UUID,
    "icon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "envId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "sourceAgentId" UUID,
    "sourceLabel" TEXT,
    "category" "AlertCategory" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "recommendation" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'open',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDoc" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "repoId" UUID,
    "envId" UUID,
    "authorUserId" UUID,
    "title" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "body" TEXT,
    "type" "KnowledgeType" NOT NULL,
    "tags" TEXT[],
    "source" "KnowledgeSource" NOT NULL DEFAULT 'written',
    "fileName" TEXT,
    "mimeType" TEXT,
    "fileSizeBytes" INTEGER,
    "storageRef" TEXT,
    "pageCount" INTEGER,
    "ingestStatus" "KnowledgeIngestStatus" NOT NULL DEFAULT 'ready',
    "ingestError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" UUID NOT NULL,
    "docId" UUID NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER,
    "page" INTEGER,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "projectId" UUID NOT NULL,
    "repoId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "labels" TEXT[],
    "reviewedByAgentId" UUID,
    "verdict" "IssueVerdict",
    "state" "IssueState" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatThread" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "threadId" UUID,
    "role" "ChatRole" NOT NULL,
    "authorUserId" UUID,
    "agentId" UUID,
    "modelId" UUID,
    "text" TEXT NOT NULL,
    "codeBody" TEXT,
    "codeLang" TEXT,
    "prNumber" INTEGER,
    "prRepoId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatPlanStep" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "icon" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "repoId" UUID,
    "order" INTEGER NOT NULL,

    CONSTRAINT "ChatPlanStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatSuggestion" (
    "id" UUID NOT NULL,
    "projectId" UUID,
    "icon" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "agentId" UUID,
    "envId" UUID,
    "allEnvs" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "status" "TaskStatus" NOT NULL DEFAULT 'ok',
    "findingsSummary" TEXT,
    "progressPct" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudProvider" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "CloudKind" NOT NULL,
    "name" TEXT NOT NULL,
    "accountRef" TEXT NOT NULL,
    "accountId" TEXT,
    "roleArn" TEXT,
    "externalId" TEXT,
    "region" TEXT NOT NULL,
    "status" "HealthStatus" NOT NULL DEFAULT 'ok',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CloudProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudSecurityScope" (
    "id" UUID NOT NULL,
    "cloudProviderId" UUID NOT NULL,
    "kind" "SecurityScopeKind" NOT NULL,
    "name" TEXT NOT NULL,
    "ref" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CloudSecurityScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvSecurityBinding" (
    "id" UUID NOT NULL,
    "envId" UUID NOT NULL,
    "scopeId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvSecurityBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "authType" "IntegrationAuthType" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'disconnected',
    "connectedById" UUID,
    "connectedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationOAuth" (
    "id" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "externalAccountId" TEXT,
    "externalAccountLabel" TEXT,
    "accessTokenRef" TEXT NOT NULL,
    "refreshTokenRef" TEXT,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "IntegrationOAuth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationCredential" (
    "id" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "valueRef" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostSnapshot" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "forecastCents" INTEGER,
    "budgetCents" INTEGER,
    "savingsCents" INTEGER,
    "untaggedCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostByEnv" (
    "id" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "envId" UUID,
    "label" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostByEnv_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostByService" (
    "id" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "service" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "pct" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostByService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostTrendPoint" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "monthStart" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,

    CONSTRAINT "CostTrendPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObservabilityKpi" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "envId" UUID,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "unit" TEXT,
    "tone" "HealthStatus" NOT NULL DEFAULT 'ok',
    "series" INTEGER[],
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObservabilityKpi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrometheusTarget" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TargetStatus" NOT NULL,
    "series" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrometheusTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrafanaDashboard" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrafanaDashboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "triggerDescription" TEXT NOT NULL,
    "approvalPolicy" TEXT NOT NULL,
    "modelId" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "systemPrompt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Model" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "ModelProvider" NOT NULL,
    "ctxTokens" INTEGER,
    "inputCostPerMTokCents" INTEGER,
    "outputCostPerMTokCents" INTEGER,
    "costNote" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpConnector" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "McpStatus" NOT NULL DEFAULT 'ok',
    "authType" "McpAuthType" NOT NULL DEFAULT 'none',
    "avgCallsPerDay" INTEGER,
    "avgLatencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpConnector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuth" (
    "id" UUID NOT NULL,
    "connectorId" UUID NOT NULL,
    "accessTokenRef" TEXT NOT NULL,
    "refreshTokenRef" TEXT,
    "scopes" TEXT[],
    "tokenType" TEXT,
    "authorizationServer" TEXT,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "McpOAuth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpCredential" (
    "id" UUID NOT NULL,
    "connectorId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "valueRef" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "McpCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMcpConnection" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "connectorId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'disconnected',
    "connectedById" UUID,
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMcpConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "id" UUID NOT NULL,
    "siteTitle" TEXT NOT NULL,
    "metaDescription" TEXT NOT NULL,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "fromAddress" TEXT,
    "smtpVerifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAsset" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "url" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformEnvVar" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "valueRef" TEXT NOT NULL,
    "status" "HealthStatus" NOT NULL DEFAULT 'ok',
    "statusLabel" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformEnvVar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemComponent" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "HealthStatus" NOT NULL DEFAULT 'ok',
    "note" TEXT NOT NULL,

    CONSTRAINT "SystemComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "projectId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE INDEX "BackupCode_userId_batchId_idx" ON "BackupCode"("userId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "BackupCode_userId_codeHash_key" ON "BackupCode"("userId", "codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_userId_status_idx" ON "Session"("userId", "status");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MagicLink_tokenHash_key" ON "MagicLink"("tokenHash");

-- CreateIndex
CREATE INDEX "MagicLink_email_idx" ON "MagicLink"("email");

-- CreateIndex
CREATE INDEX "MagicLink_expiresAt_idx" ON "MagicLink"("expiresAt");

-- CreateIndex
CREATE INDEX "OAuthAccount_userId_idx" ON "OAuthAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_provider_providerAccountId_key" ON "OAuthAccount"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "TotpCredential_userId_key" ON "TotpCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_tier_key" ON "Plan"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethod_stripePaymentMethodId_key" ON "PaymentMethod"("stripePaymentMethodId");

-- CreateIndex
CREATE INDEX "PaymentMethod_userId_idx" ON "PaymentMethod"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionAddon_stripeSubscriptionItemId_key" ON "SubscriptionAddon"("stripeSubscriptionItemId");

-- CreateIndex
CREATE INDEX "SubscriptionAddon_subscriptionId_idx" ON "SubscriptionAddon"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_stripeInvoiceId_key" ON "Invoice"("stripeInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE INDEX "Invoice_userId_status_idx" ON "Invoice"("userId", "status");

-- CreateIndex
CREATE INDEX "Invoice_userId_issuedAt_idx" ON "Invoice"("userId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Usage_userId_key" ON "Usage"("userId");

-- CreateIndex
CREATE INDEX "UsageSample_userId_idx" ON "UsageSample"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageSample_userId_weekStart_key" ON "UsageSample"("userId", "weekStart");

-- CreateIndex
CREATE INDEX "StripeEvent_type_idx" ON "StripeEvent"("type");

-- CreateIndex
CREATE INDEX "CheckoutSession_userId_idx" ON "CheckoutSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "Project_ownerId_idx" ON "Project"("ownerId");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_projectId_userId_key" ON "Membership"("projectId", "userId");

-- CreateIndex
CREATE INDEX "ProjectInvitation_email_idx" ON "ProjectInvitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectInvitation_projectId_email_key" ON "ProjectInvitation"("projectId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSetting_projectId_key" ON "ProjectSetting"("projectId");

-- CreateIndex
CREATE INDEX "Repo_ownerId_idx" ON "Repo"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Repo_ownerId_fullName_key" ON "Repo"("ownerId", "fullName");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRepo_projectId_repoId_key" ON "ProjectRepo"("projectId", "repoId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvRepo_envId_repoId_key" ON "EnvRepo"("envId", "repoId");

-- CreateIndex
CREATE UNIQUE INDEX "Env_currentDeploymentId_key" ON "Env"("currentDeploymentId");

-- CreateIndex
CREATE INDEX "Env_projectId_idx" ON "Env"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Env_projectId_key_key" ON "Env"("projectId", "key");

-- CreateIndex
CREATE INDEX "Deployment_envId_idx" ON "Deployment"("envId");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_envId_sequence_key" ON "Deployment"("envId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentRepo_deploymentId_repoId_key" ON "DeploymentRepo"("deploymentId", "repoId");

-- CreateIndex
CREATE INDEX "ManagedResource_projectId_envId_idx" ON "ManagedResource"("projectId", "envId");

-- CreateIndex
CREATE INDEX "ManagedResource_envId_category_idx" ON "ManagedResource"("envId", "category");

-- CreateIndex
CREATE INDEX "ManagedResource_category_idx" ON "ManagedResource"("category");

-- CreateIndex
CREATE UNIQUE INDEX "Pipeline_deploymentId_key" ON "Pipeline"("deploymentId");

-- CreateIndex
CREATE INDEX "Pipeline_projectId_envId_idx" ON "Pipeline"("projectId", "envId");

-- CreateIndex
CREATE INDEX "PipelineStage_pipelineId_idx" ON "PipelineStage"("pipelineId");

-- CreateIndex
CREATE INDEX "Approval_projectId_status_idx" ON "Approval"("projectId", "status");

-- CreateIndex
CREATE INDEX "ApprovalDiff_approvalId_idx" ON "ApprovalDiff"("approvalId");

-- CreateIndex
CREATE INDEX "Activity_projectId_createdAt_idx" ON "Activity"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_projectId_category_idx" ON "Alert"("projectId", "category");

-- CreateIndex
CREATE INDEX "Alert_projectId_status_idx" ON "Alert"("projectId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeDoc_projectId_idx" ON "KnowledgeDoc"("projectId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_docId_idx" ON "KnowledgeChunk"("docId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_docId_chunkIndex_key" ON "KnowledgeChunk"("docId", "chunkIndex");

-- CreateIndex
CREATE INDEX "Issue_projectId_state_idx" ON "Issue"("projectId", "state");

-- CreateIndex
CREATE INDEX "Issue_reviewedByAgentId_verdict_idx" ON "Issue"("reviewedByAgentId", "verdict");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_repoId_number_key" ON "Issue"("repoId", "number");

-- CreateIndex
CREATE INDEX "ChatThread_projectId_idx" ON "ChatThread"("projectId");

-- CreateIndex
CREATE INDEX "ChatMessage_projectId_createdAt_idx" ON "ChatMessage"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_threadId_idx" ON "ChatMessage"("threadId");

-- CreateIndex
CREATE INDEX "ChatPlanStep_messageId_idx" ON "ChatPlanStep"("messageId");

-- CreateIndex
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");

-- CreateIndex
CREATE INDEX "Task_nextRunAt_idx" ON "Task"("nextRunAt");

-- CreateIndex
CREATE INDEX "CloudProvider_userId_idx" ON "CloudProvider"("userId");

-- CreateIndex
CREATE INDEX "CloudSecurityScope_cloudProviderId_idx" ON "CloudSecurityScope"("cloudProviderId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvSecurityBinding_envId_scopeId_key" ON "EnvSecurityBinding"("envId", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_projectId_provider_key" ON "Integration"("projectId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationOAuth_integrationId_key" ON "IntegrationOAuth"("integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCredential_integrationId_key_key" ON "IntegrationCredential"("integrationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "CostSnapshot_projectId_periodStart_key" ON "CostSnapshot"("projectId", "periodStart");

-- CreateIndex
CREATE INDEX "CostByEnv_snapshotId_idx" ON "CostByEnv"("snapshotId");

-- CreateIndex
CREATE INDEX "CostByService_snapshotId_idx" ON "CostByService"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "CostTrendPoint_projectId_monthStart_key" ON "CostTrendPoint"("projectId", "monthStart");

-- CreateIndex
CREATE INDEX "ObservabilityKpi_projectId_idx" ON "ObservabilityKpi"("projectId");

-- CreateIndex
CREATE INDEX "PrometheusTarget_projectId_idx" ON "PrometheusTarget"("projectId");

-- CreateIndex
CREATE INDEX "GrafanaDashboard_projectId_idx" ON "GrafanaDashboard"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuth_connectorId_key" ON "McpOAuth"("connectorId");

-- CreateIndex
CREATE UNIQUE INDEX "McpCredential_connectorId_key_key" ON "McpCredential"("connectorId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMcpConnection_projectId_connectorId_key" ON "ProjectMcpConnection"("projectId", "connectorId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAsset_key_key" ON "PlatformAsset"("key");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformEnvVar_key_key" ON "PlatformEnvVar"("key");

-- CreateIndex
CREATE UNIQUE INDEX "SystemComponent_key_key" ON "SystemComponent"("key");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_projectId_createdAt_idx" ON "AuditLog"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupCode" ADD CONSTRAINT "BackupCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MagicLink" ADD CONSTRAINT "MagicLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthAccount" ADD CONSTRAINT "OAuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TotpCredential" ADD CONSTRAINT "TotpCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionAddon" ADD CONSTRAINT "SubscriptionAddon_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionAddon" ADD CONSTRAINT "SubscriptionAddon_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "Addon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Usage" ADD CONSTRAINT "Usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageSample" ADD CONSTRAINT "UsageSample_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectInvitation" ADD CONSTRAINT "ProjectInvitation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectInvitation" ADD CONSTRAINT "ProjectInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectInvitation" ADD CONSTRAINT "ProjectInvitation_acceptedUserId_fkey" FOREIGN KEY ("acceptedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSetting" ADD CONSTRAINT "ProjectSetting_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSetting" ADD CONSTRAINT "ProjectSetting_defaultModelId_fkey" FOREIGN KEY ("defaultModelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repo" ADD CONSTRAINT "Repo_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepo" ADD CONSTRAINT "ProjectRepo_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepo" ADD CONSTRAINT "ProjectRepo_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvRepo" ADD CONSTRAINT "EnvRepo_envId_fkey" FOREIGN KEY ("envId") REFERENCES "Env"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvRepo" ADD CONSTRAINT "EnvRepo_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Env" ADD CONSTRAINT "Env_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Env" ADD CONSTRAINT "Env_cloudProviderId_fkey" FOREIGN KEY ("cloudProviderId") REFERENCES "CloudProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Env" ADD CONSTRAINT "Env_currentDeploymentId_fkey" FOREIGN KEY ("currentDeploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_envId_fkey" FOREIGN KEY ("envId") REFERENCES "Env"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_triggeredByAgentId_fkey" FOREIGN KEY ("triggeredByAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_rollbackOfId_fkey" FOREIGN KEY ("rollbackOfId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentRepo" ADD CONSTRAINT "DeploymentRepo_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentRepo" ADD CONSTRAINT "DeploymentRepo_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedResource" ADD CONSTRAINT "ManagedResource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedResource" ADD CONSTRAINT "ManagedResource_envId_fkey" FOREIGN KEY ("envId") REFERENCES "Env"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedResource" ADD CONSTRAINT "ManagedResource_cloudProviderId_fkey" FOREIGN KEY ("cloudProviderId") REFERENCES "CloudProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_envId_fkey" FOREIGN KEY ("envId") REFERENCES "Env"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_triggeredByAgentId_fkey" FOREIGN KEY ("triggeredByAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_retryOfId_fkey" FOREIGN KEY ("retryOfId") REFERENCES "Pipeline"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_envId_fkey" FOREIGN KEY ("envId") REFERENCES "Env"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_requestedByAgentId_fkey" FOREIGN KEY ("requestedByAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDiff" ADD CONSTRAINT "ApprovalDiff_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_actorAgentId_fkey" FOREIGN KEY ("actorAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_envId_fkey" FOREIGN KEY ("envId") REFERENCES "Env"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_envId_fkey" FOREIGN KEY ("envId") REFERENCES "Env"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_sourceAgentId_fkey" FOREIGN KEY ("sourceAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDoc" ADD CONSTRAINT "KnowledgeDoc_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDoc" ADD CONSTRAINT "KnowledgeDoc_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDoc" ADD CONSTRAINT "KnowledgeDoc_envId_fkey" FOREIGN KEY ("envId") REFERENCES "Env"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDoc" ADD CONSTRAINT "KnowledgeDoc_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_docId_fkey" FOREIGN KEY ("docId") REFERENCES "KnowledgeDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_reviewedByAgentId_fkey" FOREIGN KEY ("reviewedByAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_prRepoId_fkey" FOREIGN KEY ("prRepoId") REFERENCES "Repo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPlanStep" ADD CONSTRAINT "ChatPlanStep_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPlanStep" ADD CONSTRAINT "ChatPlanStep_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSuggestion" ADD CONSTRAINT "ChatSuggestion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_envId_fkey" FOREIGN KEY ("envId") REFERENCES "Env"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudProvider" ADD CONSTRAINT "CloudProvider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudSecurityScope" ADD CONSTRAINT "CloudSecurityScope_cloudProviderId_fkey" FOREIGN KEY ("cloudProviderId") REFERENCES "CloudProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvSecurityBinding" ADD CONSTRAINT "EnvSecurityBinding_envId_fkey" FOREIGN KEY ("envId") REFERENCES "Env"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvSecurityBinding" ADD CONSTRAINT "EnvSecurityBinding_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "CloudSecurityScope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationOAuth" ADD CONSTRAINT "IntegrationOAuth_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostSnapshot" ADD CONSTRAINT "CostSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostByEnv" ADD CONSTRAINT "CostByEnv_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "CostSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostByEnv" ADD CONSTRAINT "CostByEnv_envId_fkey" FOREIGN KEY ("envId") REFERENCES "Env"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostByService" ADD CONSTRAINT "CostByService_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "CostSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostTrendPoint" ADD CONSTRAINT "CostTrendPoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObservabilityKpi" ADD CONSTRAINT "ObservabilityKpi_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrometheusTarget" ADD CONSTRAINT "PrometheusTarget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrafanaDashboard" ADD CONSTRAINT "GrafanaDashboard_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuth" ADD CONSTRAINT "McpOAuth_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "McpConnector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpCredential" ADD CONSTRAINT "McpCredential_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "McpConnector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMcpConnection" ADD CONSTRAINT "ProjectMcpConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMcpConnection" ADD CONSTRAINT "ProjectMcpConnection_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "McpConnector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
