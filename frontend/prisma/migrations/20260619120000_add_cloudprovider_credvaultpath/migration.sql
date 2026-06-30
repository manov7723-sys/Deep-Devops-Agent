-- Add a non-secret pointer to the HashiCorp Vault path that holds a cloud
-- provider's AWS access key + secret. Secrets live in Vault, not Postgres.
ALTER TABLE "CloudProvider" ADD COLUMN "credVaultPath" TEXT;
