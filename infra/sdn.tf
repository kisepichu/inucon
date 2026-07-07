resource "proxmox_virtual_environment_sdn_zone_simple" "inucon" {
  id    = "inucon"
  nodes = [var.node_name]
}

resource "proxmox_virtual_environment_sdn_vnet" "team" {
  for_each = var.teams

  id   = "team${each.key}"
  zone = proxmox_virtual_environment_sdn_zone_simple.inucon.id
}

resource "proxmox_virtual_environment_sdn_subnet" "team" {
  for_each = var.teams

  subnet  = "10.100.${each.key}.0/24"
  vnet    = proxmox_virtual_environment_sdn_vnet.team[each.key].id
  gateway = "10.100.${each.key}.1"
  snat    = true
}

# SDN は変更後に applier で反映が必要
resource "proxmox_virtual_environment_sdn_applier" "apply" {
  depends_on = [proxmox_virtual_environment_sdn_subnet.team]
}
