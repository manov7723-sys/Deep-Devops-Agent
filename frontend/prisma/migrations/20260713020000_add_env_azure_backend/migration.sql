-- Per-env Azure remote-state backend (Storage Account + Blob Container in a
-- Resource Group). Azure uses blob leases for locking natively, so no separate
-- lock table is needed. All three nullable — populated together via the
-- Connection page's Terraform state backend section.
ALTER TABLE "Env" ADD COLUMN "tfBackendAzureResourceGroup" TEXT;
ALTER TABLE "Env" ADD COLUMN "tfBackendAzureStorageAccount" TEXT;
ALTER TABLE "Env" ADD COLUMN "tfBackendAzureContainer" TEXT;
