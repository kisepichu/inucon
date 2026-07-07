terraform {
  required_version = ">= 1.6"
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = ">= 0.80"
    }
    http = {
      source  = "hashicorp/http"
      version = ">= 3.4"
    }
  }
}

provider "proxmox" {
  endpoint  = "https://192.0.2.10:8006"
  api_token = var.pve_api_token
  insecure  = true # 自己署名証明書のため

  ssh {
    agent    = true
    username = "root"
  }
}
