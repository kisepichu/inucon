terraform {
  required_version = ">= 1.6"
  required_providers {
    proxmox = {
      source = "bpg/proxmox"
      # < 1.0.0 の理由: v1.0 で SDN リソースが proxmox_sdn_* にリネーム予定(現行の
      # proxmox_virtual_environment_sdn_* は deprecated)。上げる際は sdn.tf の追従が必要
      version = ">= 0.111.0, < 1.0.0"
    }
    http = {
      source  = "hashicorp/http"
      version = ">= 3.4"
    }
  }
}

provider "proxmox" {
  endpoint  = var.pve_endpoint
  api_token = var.pve_api_token
  insecure  = var.pve_insecure

  ssh {
    agent    = true
    username = var.pve_ssh_username
  }
}
