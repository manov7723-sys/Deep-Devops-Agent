-- Persistent Terraform pipeline runs. Used to be in-memory only, so dev-server
-- restarts and Turbopack HMR reloads wiped history + broke rerun. Now stored
-- here so the Terraform pipeline UI, Rerun button, and approval→run linkage
-- all survive process restarts.
--
-- stages / sourceFiles / sourceBackend are JSONB — their shapes live in
-- lib/devops/terraform-run.ts.
CREATE TABLE "TfRun" (
  "id"              TEXT NOT NULL,
  "projectId"       UUID NOT NULL,
  "envId"           UUID NOT NULL,
  "envKey"          TEXT NOT NULL,
  "cloudProviderId" UUID,
  "name"            TEXT NOT NULL,
  "action"          TEXT NOT NULL,
  "status"          TEXT NOT NULL,
  "stages"          JSONB NOT NULL DEFAULT '[]',
  "sourceFiles"     JSONB NOT NULL DEFAULT '{}',
  "sourceStack"     TEXT,
  "sourceBackend"   JSONB,
  "errorMessage"    TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"      TIMESTAMP(3),
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TfRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TfRun_projectId_envId_createdAt_idx"
  ON "TfRun"("projectId", "envId", "createdAt" DESC);
CREATE INDEX "TfRun_envId_createdAt_idx"
  ON "TfRun"("envId", "createdAt" DESC);

ALTER TABLE "TfRun" ADD CONSTRAINT "TfRun_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TfRun" ADD CONSTRAINT "TfRun_envId_fkey"
  FOREIGN KEY ("envId") REFERENCES "Env"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
