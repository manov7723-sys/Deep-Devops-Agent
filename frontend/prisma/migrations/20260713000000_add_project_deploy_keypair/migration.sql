-- Per-project deploy keypair used to SSH into Proxmox VMs the project
-- provisions. Public key is baked into VM cloud-init on create; private key
-- is AES-256-GCM encrypted at rest and injected into a repo secret by the
-- Proxmox deploy workflow generator. Both nullable — populated lazily by the
-- first deploy_to_proxmox_vm run for a project.
ALTER TABLE "Project" ADD COLUMN "deployPublicKey" TEXT;
ALTER TABLE "Project" ADD COLUMN "deployPrivateKeyEnc" TEXT;
