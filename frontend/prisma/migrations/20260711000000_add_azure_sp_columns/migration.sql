-- Hybrid Azure auth: OAuth stays the connect UX, but the app also stores a
-- Service Principal (auto-provisioned via Microsoft Graph after OAuth sign-in)
-- so keyless deployment + cluster ops can run without falling back to ACR
-- admin secrets. Columns are nullable so existing OAuth-only rows still work;
-- auto-provisioning is best-effort at connect time.
ALTER TABLE "CloudProvider" ADD COLUMN "spClientId" TEXT;
ALTER TABLE "CloudProvider" ADD COLUMN "spClientSecretEnc" TEXT;
