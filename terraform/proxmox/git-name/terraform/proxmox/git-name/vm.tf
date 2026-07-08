resource "proxmox_virtual_environment_vm" "git_name" {
  name      = "git-name"
  node_name = "pve"

  clone {
    vm_id = 9000
    full  = true
  }

  cpu {
    cores = 2
    type  = "host"
  }

  memory {
    dedicated = 2048
  }

  disk {
    datastore_id = "local-lvm"
    interface    = "scsi0"
    size         = 20
  }

  network_device {
    bridge = "vmbr0"
  }

  initialization {
    ip_config {
      ipv4 {
        address = "dhcp"
      }
    }
  }

  agent {
    enabled = true
  }
}

output "vm_id" {
  value = proxmox_virtual_environment_vm.git_name.vm_id
}

output "vm_name" {
  value = proxmox_virtual_environment_vm.git_name.name
}
