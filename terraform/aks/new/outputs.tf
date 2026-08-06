output "cluster_name" {
  value = azurerm_kubernetes_cluster.aks.name
}

output "resource_group" {
  value = local.rg_name
}

output "location" {
  value = local.location
}

output "update_kubeconfig_command" {
  value = "az aks get-credentials --resource-group ${local.rg_name} --name ${azurerm_kubernetes_cluster.aks.name}"
}
