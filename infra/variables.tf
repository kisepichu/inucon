variable "pve_api_token" {
  type        = string
  sensitive   = true
  description = "terraform@pve!tf=<value> の形式"
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
}
