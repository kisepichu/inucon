locals {
  team_instances = merge([
    for tnum, t in var.teams : {
      for i in range(1, t.instances + 1) :
      "team${tnum}-${i}" => {
        team         = tnum
        vmid         = 1000 + tonumber(tnum) * 100 + i
        ip           = "10.100.${tnum}.${10 + i}" # ホスト部 = 10 + M (Global Constraints)
        github_users = t.github_users
      }
    }
  ]...)

  all_github_users = toset(flatten([for t in var.teams : t.github_users]))
}

data "http" "github_keys" {
  for_each = local.all_github_users
  url      = "https://github.com/${each.key}.keys"

  lifecycle {
    postcondition {
      condition     = self.status_code == 200
      error_message = "GitHub ユーザー ${each.key} の公開鍵取得に失敗 (HTTP ${self.status_code})。ユーザー名の typo の可能性。"
    }
  }
}

resource "proxmox_virtual_environment_file" "team_user_data" {
  for_each     = local.team_instances
  content_type = "snippets"
  datastore_id = "local"
  node_name    = var.node_name

  source_raw {
    file_name = "inucon-${each.key}.yaml"
    data = templatefile("${path.module}/templates/team-user-data.yaml.tftpl", {
      hostname = "inucon-${each.key}"
      # 公開鍵形式の行だけ通す(非 200 応答は postcondition で弾くが、念のため本文もフィルタ)
      ssh_keys = distinct([
        for line in compact(flatten([
          for u in each.value.github_users :
          split("\n", trimspace(data.http.github_keys[u].response_body))
        ])) : line if can(regex("^(ssh-|ecdsa-|sk-)", line))
      ])
    })
  }
}

resource "proxmox_virtual_environment_vm" "team" {
  for_each  = local.team_instances
  name      = "inucon-${each.key}"
  node_name = var.node_name
  vm_id     = each.value.vmid

  clone {
    vm_id = var.problem_template_vmid
    full  = false # linked clone (local-zfs)
  }

  cpu {
    cores = 2
    type  = "host"
  }
  memory {
    dedicated = 4096
  }

  agent {
    enabled = true
  }

  network_device {
    bridge = "team${each.value.team}"
    model  = "virtio"
  }

  initialization {
    datastore_id      = "local-zfs"
    user_data_file_id = proxmox_virtual_environment_file.team_user_data[each.key].id

    ip_config {
      ipv4 {
        address = "${each.value.ip}/24"
        gateway = "10.100.${each.value.team}.1"
      }
    }
    dns {
      servers = ["1.1.1.1"]
    }
  }
}
