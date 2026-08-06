locals {
  cluster_name = "level-1"
  location     = "eastus"
  tags = {
    ManagedBy   = "DeepAgent"
    Cluster     = "level-1"
    Environment = "production"
    Team        = "devops"
  }
}

data "azurerm_resource_group" "rg" {
  name = "rg-devops"
}

locals {
  rg_name     = data.azurerm_resource_group.rg.name
  rg_location = data.azurerm_resource_group.rg.location
}

resource "azurerm_log_analytics_workspace" "law" {
  name                = "${local.cluster_name}-law"
  location            = local.rg_location
  resource_group_name = local.rg_name
  sku                 = "PerGB2018"
  retention_in_days   = 90
  tags                = local.tags
}

resource "azurerm_kubernetes_cluster" "aks" {
  name                = local.cluster_name
  location            = local.rg_location
  resource_group_name = local.rg_name
  dns_prefix          = local.cluster_name
  kubernetes_version  = "1.35"
  sku_tier                  = "Standard"
  automatic_channel_upgrade = "patch"
  oidc_issuer_enabled       = true
  workload_identity_enabled = true
  azure_policy_enabled      = true

  default_node_pool {
    name                         = "systempool"
    vm_size                      = "Standard_D2s_v3"
    node_count                   = 2
    enable_auto_scaling          = true
    min_count                    = 2
    max_count                    = 5
    os_disk_size_gb              = 30
    os_disk_type                 = "Managed"
    max_pods                     = 50
    only_critical_addons_enabled = true
    tags                         = local.tags
  }

  identity {
    type = "SystemAssigned"
  }

  azure_active_directory_role_based_access_control {
    managed            = true
    azure_rbac_enabled = true
  }

  network_profile {
    network_plugin    = "azure"
    network_policy    = "azure"
    load_balancer_sku = "standard"
    service_cidr      = "10.100.0.0/16"
    dns_service_ip    = "10.100.0.10"
  }

  oms_agent {
    log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id
  }

  monitor_metrics {}

  key_vault_secrets_provider {
    secret_rotation_enabled = true
  }

  workload_autoscaler_profile {
    keda_enabled                    = true
    vertical_pod_autoscaler_enabled = true
  }

  tags = local.tags

  # AKS creates typically take 15-25 min; private clusters + workload identity
  # + monitoring add-ons can push past 30. Give the provider room so it
  # doesn't give up while Azure is still working.
  timeouts {
    create = "45m"
    update = "45m"
    delete = "30m"
  }
}

resource "azurerm_kubernetes_cluster_node_pool" "app" {
  name                  = "apppool"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.aks.id
  vm_size               = "Standard_D2s_v3"
  enable_auto_scaling   = true
  min_count             = 1
  max_count             = 2
  priority              = "Regular"
  node_labels = {
    role = "application"
    env  = "production"
  }
  tags = local.tags
}
