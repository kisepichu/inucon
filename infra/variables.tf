variable "pve_api_token" {
  type        = string
  sensitive   = true
  description = "terraform@pve!tf=<value> の形式"
}

variable "pve_endpoint" {
  description = "Proxmox VE API endpoint"
  type        = string
  default     = "https://192.0.2.10:8006"
}

variable "pve_insecure" {
  description = "自己署名証明書のため TLS 検証を無効化する(自宅 LAN 内前提)"
  type        = bool
  default     = true
}

variable "node_name" {
  type    = string
  default = "eevee"
}

variable "problem_template_vmid" {
  description = "問題テンプレートの vmid (Task 4 で作る tpl-private-isu)"
  type        = number
  default     = 9100
}

variable "teams" {
  description = "チーム定義。キーはチーム番号 (文字列)"
  type = map(object({
    github_users = list(string)
    instances    = number
  }))
  default = {
    "1" = { github_users = ["kisepichu"], instances = 1 }
    "2" = { github_users = ["kisepichu"], instances = 1 }
  }

  validation {
    condition = alltrue([
      for k, t in var.teams : can(regex("^([1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-4])$", k))
    ])
    error_message = "teams のキーは 1〜254 の数値文字列(先頭ゼロなし)にすること。IP の第 3 オクテット (10.100.<key>.0/24) に使われる。"
  }
}
