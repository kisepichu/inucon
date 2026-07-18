# NOTE: simple zone は vnet ごとに独立ブリッジ + SNAT(アウトバウンド)を構成するのみで、
# vnet 間(team1 <-> team2)のルーティングを遮断する iptables/firewall ルールは自動生成しない。
# ホスト eevee は各 vnet に直接 (scope link) 接続し forwarding が有効なため、対策なしだと
# チーム間で自由に通信できてしまう(Task 6 検証で判明)。
# 現状はチーム間分離を eevee 上の FORWARD チェーン DROP ルール(systemd unit
# `inucon-team-isolation.service`)で実現している。詳細・再適用手順は
# infra/docs/team-isolation.md を参照。
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

  cidr    = "10.100.${each.key}.0/24" # provider v0.111 では引数名が subnet ではなく cidr
  vnet    = proxmox_virtual_environment_sdn_vnet.team[each.key].id
  gateway = "10.100.${each.key}.1"
  snat    = true
}

# SDN は変更後に applier で反映が必要
resource "proxmox_virtual_environment_sdn_applier" "apply" {
  depends_on = [proxmox_virtual_environment_sdn_subnet.team]
}
