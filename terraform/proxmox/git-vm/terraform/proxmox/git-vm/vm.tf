resource "proxmox_virtual_environment_vm" "git_vm" {
  name      = "git-vm"
  node_name = "proxmox-test"

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
    datastore_id = "local"
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
  value = proxmox_virtual_environment_vm.git_vm.vm_id
}

output "vm_name" {
  value = proxmox_virtual_environment_vm.git_vm.name
}
