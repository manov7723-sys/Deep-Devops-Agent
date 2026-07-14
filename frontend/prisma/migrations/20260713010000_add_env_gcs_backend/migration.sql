-- Per-env GCP remote-state bucket, analogous to tfBackendBucket for S3.
-- GCS uses object generations for locking so no separate lock table needed.
-- Nullable — envs without a GCS backend fall back to local state.
ALTER TABLE "Env" ADD COLUMN "tfBackendGcsBucket" TEXT;
