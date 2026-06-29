/*
  Warnings:

  - A unique constraint covering the columns `[oauthAccountId,fullName]` on the table `Repo` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "ModelProvider" ADD VALUE 'Groq';

-- AlterEnum
ALTER TYPE "StageStatus" ADD VALUE 'skipped';

-- DropIndex
DROP INDEX "PipelineStage_pipelineId_idx";

-- AlterTable
ALTER TABLE "Env" ADD COLUMN     "kubeconfigRef" TEXT,
ADD COLUMN     "namespace" TEXT NOT NULL DEFAULT 'default',
ADD COLUMN     "tfBackendBucket" TEXT,
ADD COLUMN     "tfBackendRegion" TEXT,
ADD COLUMN     "tfBackendTable" TEXT;

-- AlterTable
ALTER TABLE "OAuthAccount" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "login" TEXT;

-- AlterTable
ALTER TABLE "PipelineStage" ADD COLUMN     "exitCode" INTEGER,
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "logs" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Repo" ADD COLUMN     "oauthAccountId" UUID;

-- CreateTable
CREATE TABLE "OAuthProviderConfig" (
    "id" UUID NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretRef" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OAuthProviderConfig_provider_key" ON "OAuthProviderConfig"("provider");

-- CreateIndex
CREATE INDEX "PipelineStage_pipelineId_order_idx" ON "PipelineStage"("pipelineId", "order");

-- CreateIndex
CREATE INDEX "Repo_oauthAccountId_idx" ON "Repo"("oauthAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Repo_oauthAccountId_fullName_key" ON "Repo"("oauthAccountId", "fullName");

-- AddForeignKey
ALTER TABLE "Repo" ADD CONSTRAINT "Repo_oauthAccountId_fkey" FOREIGN KEY ("oauthAccountId") REFERENCES "OAuthAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
