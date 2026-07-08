terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.66"
    }
  }
}

# Endpoint, API token and TLS mode are read from the environment:
#   PROXMOX_VE_ENDPOINT, PROXMOX_VE_API_TOKEN, PROXMOX_VE_INSECURE
# (injected by DeepAgent from the connected Proxmox provider — no secrets in HCL).
provider "proxmox" {}
