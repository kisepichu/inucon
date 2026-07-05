# Phase 1: 手動 MVP 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ポータルなしで INUCON の全インフラ要素(private-isu テンプレート、チーム VM 払い出し、SDN 分離、Cloudflare Access 越し SSH、benchvm からのベンチ実行)を Terraform + スクリプトで構築し、スペックの未検証項目を実証する。

**Architecture:** テンプレート構築(base Ubuntu / private-isu)は eevee 上で実行する bash スクリプト、SDN・チーム VM 払い出しは Terraform(bpg/proxmox)で管理する。benchvm は nixos-config-private リポジトリで宣言し VMA イメージとして eevee に restore する。外部アクセスは benchvm 上の cloudflared + Cloudflare Access。

**Tech Stack:** Proxmox VE API / Terraform (bpg/proxmox, hashicorp/http) / cloud-init / NixOS + nixos-generators / cloudflared / private-isu ベンチマーカー (Go)

**Spec:** `docs/superpowers/specs/2026-07-04-inucon-design.md`

## Global Constraints

- vmid 規約: `9000` = tpl-ubuntu-noble、`9100` = tpl-private-isu、`9200` = benchvm、チーム VM = `1000 + チーム番号×100 + 連番`(例: team1-1 → `1101`、team2-1 → `1201`)
- IP 規約: チーム N のサブネット `10.100.N.0/24`、GW(eevee) `10.100.N.1`、benchvm `10.100.N.2`、チーム VM M 台目 `10.100.N.1M`(team1-1 → `10.100.1.11`)
- VM 名: `inucon-team{N}-{M}`。VNet 名: `team{N}`。SDN zone 名: `inucon`
- スペック: チーム VM `2vCPU / 4GB / 20GB`、benchvm `4vCPU / 4GB`(スペックの公平性設計を参照。RAM 4GB 未満に下げない)
- eevee: `192.0.2.10`(API: `https://192.0.2.10:8006`)。apphost: `192.0.2.20`
- Phase 1 のチーム構成: 2 チーム × 1 台(team1-1, team2-1)。メンバーの GitHub アカウントは仮に全チーム `kisepichu`
- コミットは必ず `/commit` スキルで行う。タスク単位で develop から切ったブランチに積み、`/pr` → `/pr-review` で develop へ入れる
- Task 5(benchvm 定義)と Task 8 の NixOS 変更は `~/repos/nixos-config-private`(別リポジトリ)での作業。コミットはそのリポジトリの流儀(直コミット)でよい
- 秘密情報(API トークン、tunnel credential)は git に入れない。Terraform は `terraform.tfvars`(gitignore 済み)、NixOS は agenix
- Cloudflare の DNS / Access 設定は Phase 1 ではダッシュボード手動で行い、手順を runbook に記録する(TF 化は Phase 3 でポータル自動化と一緒に検討)

---

### Task 1: eevee 事前整備と runbook

eevee に手を入れる唯一の「手作業」タスク。以後の全タスクの前提。**WebUI(`https://192.0.2.10:8006`)→ eevee → 右上「>_ Shell」** で実行する。

**Files:**
- Create: `infra/docs/eevee-setup.md`(実行したコマンドと出力を記録する runbook)

**Interfaces:**
- Produces: `terraform@pve!tf` API トークン(Task 3 の `terraform.tfvars` に入れる)、snippets が置ける `local` ストレージ、Mac から `ssh root@192.0.2.10` できる状態

- [ ] **Step 1: 現状把握(RAM 内訳・ZFS ARC)**

eevee シェルで:

```bash
qm list && pct list
free -h
arc_summary -s arc | head -20
```

Expected: `qm list` に apphost(running)。ARC size が数 GB あり、「apphost 8GB + ARC + PVE ≈ 14GB」の説明がつくこと。出力を runbook に貼る。

- [ ] **Step 2: ZFS ARC 上限を 4GiB に制限(即時 + 永続)**

```bash
echo 4294967296 > /sys/module/zfs/parameters/zfs_arc_max
echo "options zfs zfs_arc_max=4294967296" > /etc/modprobe.d/zfs.conf
update-initramfs -u -k all
free -h   # ARC が縮み available が増えることを確認(縮小は数分かかる場合あり)
```

Expected: 再起動不要で available が増える。apphost は無停止。

- [ ] **Step 3: local ストレージに snippets を許可**

```bash
pvesm status                       # 現在の content を確認
grep -A3 "dir: local" /etc/pve/storage.cfg
# 既存の content 一覧に snippets を「追加」する(既存を消さないこと):
pvesm set local --content backup,iso,vztmpl,snippets
mkdir -p /var/lib/vz/snippets
```

Expected: `grep -A3 "dir: local" /etc/pve/storage.cfg` の content 行に snippets が含まれる。

- [ ] **Step 4: Terraform 用ユーザーと API トークン作成**

```bash
pveum user add terraform@pve --comment "inucon terraform"
pveum aclmod / -user terraform@pve -role Administrator
pveum user token add terraform@pve tf --privsep 0
```

Expected: `full-tokenid = terraform@pve!tf` と `value = xxxxxxxx-...` が表示される。**value は一度しか表示されないので控える**(後で `terraform.tfvars` に書く。runbook には value を書かない)。

- [ ] **Step 5: Mac の SSH 公開鍵を eevee root に登録**

bpg provider の snippets アップロードと VMA 転送に使う。Mac 側で:

```bash
ssh-copy-id root@192.0.2.10   # パスワードは PVE の root パスワード
ssh root@192.0.2.10 hostname  # => eevee
```

Expected: パスワードなしで eevee に入れる。

- [ ] **Step 6: runbook を書いてコミット**

`infra/docs/eevee-setup.md` に Step 1〜5 の実行コマンド・結果(トークン value 除く)・実測 RAM 内訳を記録。

`/commit` を実行(例: `docs: eevee 事前整備の runbook を追加`)。

---

### Task 2: Terraform 骨組みと SDN(チーム VNet)

**Files:**
- Create: `infra/providers.tf`, `infra/variables.tf`, `infra/sdn.tf`, `infra/.gitignore`, `infra/terraform.tfvars.example`

**Interfaces:**
- Consumes: Task 1 の API トークン
- Produces: SDN zone `inucon`、VNet `team1`/`team2`(サブネット・SNAT 付き)。`var.teams`(map: チーム番号 → { github_users, instances })は Task 4 も参照する

- [ ] **Step 1: ファイル作成**

`infra/.gitignore`:

```
.terraform/
.terraform.lock.hcl
*.tfstate
*.tfstate.*
terraform.tfvars
```

`infra/providers.tf`:

```hcl
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
```

`infra/variables.tf`:

```hcl
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
```

`infra/terraform.tfvars.example`:

```hcl
pve_api_token = "terraform@pve!tf=00000000-0000-0000-0000-000000000000"
```

`infra/sdn.tf`:

```hcl
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
```

- [ ] **Step 2: terraform.tfvars を作成(gitignore 済みを確認)**

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
# terraform.tfvars を編集して Task 1 Step 4 のトークンを記入
git check-ignore terraform.tfvars   # => terraform.tfvars と出ること
```

- [ ] **Step 3: init & apply**

```bash
cd infra && terraform init && terraform apply
```

Expected: zone 1 + vnet 2 + subnet 2 + applier が created。
**Fallback:** provider が SDN リソース未対応のバージョンだった場合は provider を最新化。それでも駄目なら eevee シェルで同等を作り、TF からは SDN を外す:

```bash
pvesh create /cluster/sdn/zones --zone inucon --type simple --nodes eevee
pvesh create /cluster/sdn/vnets --vnet team1 --zone inucon
pvesh create /cluster/sdn/vnets/team1/subnets --subnet 10.100.1.0/24 --type subnet --gateway 10.100.1.1 --snat 1
pvesh create /cluster/sdn/vnets --vnet team2 --zone inucon
pvesh create /cluster/sdn/vnets/team2/subnets --subnet 10.100.2.0/24 --type subnet --gateway 10.100.2.1 --snat 1
pvesh set /cluster/sdn
```

- [ ] **Step 4: 検証**

```bash
ssh root@192.0.2.10 "pvesh get /cluster/sdn/vnets --output-format json"
ssh root@192.0.2.10 "ip addr show team1 | grep inet"
```

Expected: team1/team2 が存在し、eevee に `10.100.1.1/24` が付いたブリッジ team1 が生えている。

- [ ] **Step 5: コミット**

`/commit`(例: `infra: Terraform 骨組みと SDN チーム VNet を追加`)。

---

### Task 3: base Ubuntu テンプレート(vmid 9000)

**Files:**
- Create: `problems/base/build-base-template.sh`

**Interfaces:**
- Produces: eevee 上のテンプレート `tpl-ubuntu-noble`(vmid 9000)。Task 4 がクローン元にする

- [ ] **Step 1: スクリプト作成**

`problems/base/build-base-template.sh`:

```bash
#!/usr/bin/env bash
# eevee 上で実行する。Ubuntu 24.04 cloud image から汎用テンプレート (vmid 9000) を作る。
set -euxo pipefail

VMID=9000
IMG=/root/noble-server-cloudimg-amd64.img

if qm status "$VMID" &>/dev/null; then
  echo "vmid $VMID already exists" >&2
  exit 1
fi

wget -q -O "$IMG" https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img

qm create "$VMID" --name tpl-ubuntu-noble --ostype l26 \
  --memory 4096 --cores 2 --cpu host \
  --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-single --agent enabled=1 \
  --serial0 socket --vga serial0
qm set "$VMID" --scsi0 "local-zfs:0,import-from=$IMG"
qm disk resize "$VMID" scsi0 20G
qm set "$VMID" --ide2 local-zfs:cloudinit --boot order=scsi0
qm template "$VMID"
echo "done: tpl-ubuntu-noble ($VMID)"
```

- [ ] **Step 2: 実行**

```bash
chmod +x problems/base/build-base-template.sh
ssh root@192.0.2.10 'bash -s' < problems/base/build-base-template.sh
```

Expected: 最後に `done: tpl-ubuntu-noble (9000)`。

- [ ] **Step 3: 検証**

```bash
ssh root@192.0.2.10 "qm config 9000 | grep -E 'template|name|scsi0'"
```

Expected: `template: 1`, `name: tpl-ubuntu-noble`, scsi0 が local-zfs 上 20G。

- [ ] **Step 4: コミット**

`/commit`(例: `problems: base Ubuntu テンプレート構築スクリプトを追加`)。

---

### Task 4: private-isu 問題テンプレート(vmid 9100)— スペック最大の未検証項目

matsuu/cloud-init-isucon の cloud-config が Proxmox で動くかの実証。ここが失敗したら ansible-isucon 直流しにフォールバックする(Step 7)。

**Files:**
- Create: `problems/private-isu/user-data.build.yaml`(matsuu 版 + guest agent の統合版)
- Create: `problems/private-isu/build-template.sh`
- Create: `problems/private-isu/finalize-template.sh`
- Create: `problems/private-isu/README.md`(実測記録)

**Interfaces:**
- Consumes: vmid 9000(Task 3)、snippets ストレージ(Task 1)
- Produces: テンプレート `tpl-private-isu`(vmid 9100)。Task 6 の `clone.vm_id = var.problem_template_vmid (9100)` が参照。ゲスト内には isucon ユーザー + アプリ(nginx :80)+ MySQL が構築済み

- [ ] **Step 1: matsuu の user-data を取得して統合版を作る**

```bash
git clone --depth 1 https://github.com/matsuu/cloud-init-isucon /tmp/cloud-init-isucon
ls /tmp/cloud-init-isucon/private-isu/
```

private-isu 用の cloud-config(`user-data` などの名前のファイル。`ls` で確認)を `problems/private-isu/user-data.build.yaml` にコピーし、**以下の 2 点を追記**する:

1. トップレベルの `packages:` リストに `qemu-guest-agent` を追加(キーが無ければ新設)
2. `runcmd:` リストの**先頭**に `- systemctl enable --now qemu-guest-agent` を追加(キーが無ければ新設)

これで Proxmox からゲストの状態(cloud-init 完了・IP)が取れるようになる。それ以外の matsuu 版の内容は変更しない。

- [ ] **Step 2: ビルドスクリプト作成**

`problems/private-isu/build-template.sh`:

```bash
#!/usr/bin/env bash
# eevee 上で実行する。tpl-ubuntu-noble から private-isu 問題 VM (vmid 9100) を構築する。
# 事前に user-data.build.yaml を /var/lib/vz/snippets/private-isu-build.yaml に置くこと。
set -euxo pipefail

BASE=9000
VMID=9100
SNIPPET=/var/lib/vz/snippets/private-isu-build.yaml

[ -f "$SNIPPET" ] || { echo "snippet not found: $SNIPPET" >&2; exit 1; }
if qm status "$VMID" &>/dev/null; then
  echo "vmid $VMID already exists" >&2
  exit 1
fi

qm clone "$BASE" "$VMID" --name tpl-private-isu-build --full
qm set "$VMID" --memory 4096 --cores 2 \
  --cicustom "user=local:snippets/private-isu-build.yaml" \
  --ipconfig0 ip=dhcp
qm start "$VMID"

echo "waiting for cloud-init (初回は 10 分以上かかる)..."
SECONDS=0
while true; do
  out=$(qm guest exec "$VMID" -- cloud-init status 2>/dev/null || true)
  echo "$out" | grep -q "status: done" && break
  if echo "$out" | grep -q "status: error"; then
    echo "cloud-init failed. ログ: qm guest exec $VMID -- tail -50 /var/log/cloud-init-output.log" >&2
    exit 1
  fi
  sleep 30
  echo "  ... ${SECONDS}s"
done
echo "cloud-init done in ${SECONDS}s"
```

- [ ] **Step 3: snippets 配置と実行**

```bash
scp problems/private-isu/user-data.build.yaml root@192.0.2.10:/var/lib/vz/snippets/private-isu-build.yaml
chmod +x problems/private-isu/*.sh
ssh root@192.0.2.10 'bash -s' < problems/private-isu/build-template.sh
```

Expected: `cloud-init done in NNNNs`。所要秒数を `problems/private-isu/README.md` に記録。
失敗した場合: `ssh root@192.0.2.10 "qm guest exec 9100 -- tail -50 /var/log/cloud-init-output.log"` で原因を確認してから Step 7 のフォールバックを検討。

- [ ] **Step 4: アプリ動作検証(eevee から)**

```bash
ssh root@192.0.2.10 '
  IP=$(qm guest exec 9100 -- bash -c "hostname -I" | grep -oE "192\.0\.2\.[0-9]+" | head -1)
  echo "VM IP: $IP"
  curl -s -o /dev/null -w "%{http_code}\n" "http://$IP/"
  qm guest exec 9100 -- systemctl is-active mysql nginx
'
```

Expected: HTTP `200`、mysql/nginx が `active`(サービス名が違う場合は `qm guest exec 9100 -- systemctl list-units --type=service --state=running` で確認して README に記録)。

- [ ] **Step 5: テンプレート化(finalize)**

`problems/private-isu/finalize-template.sh`:

```bash
#!/usr/bin/env bash
# eevee 上で実行する。構築済み VM 9100 をクリーンアップしてテンプレート化する。
set -euxo pipefail
VMID=9100

qm guest exec "$VMID" -- bash -c \
  'cloud-init clean --logs && truncate -s 0 /etc/machine-id && rm -f /etc/ssh/ssh_host_*'
qm shutdown "$VMID" --timeout 180
qm set "$VMID" --name tpl-private-isu --delete cicustom --ipconfig0 ip=dhcp
qm template "$VMID"
echo "done: tpl-private-isu ($VMID)"
```

```bash
ssh root@192.0.2.10 'bash -s' < problems/private-isu/finalize-template.sh
```

Expected: `done: tpl-private-isu (9100)`。cloud-init clean によりクローン起動時に新しい user-data(SSH 鍵・ホスト名)が適用され、SSH ホスト鍵も再生成される。

- [ ] **Step 6: README に実測を記録してコミット**

`problems/private-isu/README.md` に: 構築所要時間、確認したサービス名、テンプレートのディスク使用量(`ssh root@192.0.2.10 "zfs list | grep 9100"`)。

`/commit`(例: `problems: private-isu テンプレート構築を追加(Proxmox で matsuu cloud-config 動作確認)`)。

- [ ] **Step 7: (Step 3 が失敗した場合のみ)フォールバック**

matsuu cfg が Proxmox で動かなかった場合: 素の Ubuntu VM を 9100 として起動し、[matsuu/ansible-isucon](https://github.com/matsuu/ansible-isucon) の private-isu playbook を手元から流して同じ状態を作り、Step 4 以降を続行。試行内容と結果を README に記録すること(スペックのリスク欄の検証結果になる)。

---

### Task 5: benchvm(NixOS ベンチ VM)— nixos-config-private 側

**Files:**
- Modify: `~/repos/nixos-config-private/flake.nix`
- Create: `~/repos/nixos-config-private/hosts/benchvm/configuration.nix`

**Interfaces:**
- Consumes: VNet team1/team2(Task 2)
- Produces: benchvm VM(vmid 9200、LAN DHCP + `10.100.1.2` + `10.100.2.2`)。Task 7 がベンチ実行に、Task 8 が cloudflared に使う

- [ ] **Step 1: flake.nix に benchvm と VMA パッケージを追加**

```nix
{
  description = "apphost";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    agenix.url  = "github:ryantm/agenix";
    nixos-generators = {
      url = "github:nix-community/nixos-generators";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, agenix, nixos-generators, ... }: {
    nixosConfigurations.apphost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      specialArgs = { inherit agenix; };
      modules = [
        ./hosts/apphost/configuration.nix
        agenix.nixosModules.default
      ];
    };

    nixosConfigurations.benchvm = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      specialArgs = { inherit agenix; };
      modules = [
        ./hosts/benchvm/configuration.nix
        agenix.nixosModules.default
      ];
    };

    # Proxmox 用 VMA イメージ: nix build .#benchvm-vma (x86_64-linux 上で実行)
    packages.x86_64-linux.benchvm-vma = nixos-generators.nixosGenerate {
      system = "x86_64-linux";
      format = "proxmox";
      specialArgs = { inherit agenix; };
      modules = [
        ./hosts/benchvm/configuration.nix
        agenix.nixosModules.default
      ];
    };
  };
}
```

- [ ] **Step 2: hosts/benchvm/configuration.nix 作成**

```nix
# INUCON ベンチランナー VM。ベンチ実行中に計測がぶれないよう余計な常駐サービスを置かない。
# NIC は PVE 側のスロット順で決まる: net0=ens18(vmbr0/DHCP), net1=ens19(team1), net2=ens20(team2)
{ config, lib, pkgs, agenix, ... }:

{
  networking.hostName = "benchvm";
  time.timeZone = "Asia/Tokyo";
  i18n.defaultLocale = "en_US.UTF-8";

  # nixos-generators (format = "proxmox") が qmrestore 用 VMA を作る際の VM 設定
  proxmox.qemuConf = {
    name   = "benchvm";
    cores  = 4;
    memory = 4096;
  };

  services.qemuGuest.enable = true;

  networking.useDHCP = false;
  networking.interfaces.ens18.useDHCP = true;
  networking.interfaces.ens19.ipv4.addresses = [{ address = "10.100.1.2"; prefixLength = 24; }];
  networking.interfaces.ens20.ipv4.addresses = [{ address = "10.100.2.2"; prefixLength = 24; }];
  networking.enableIPv6 = false;

  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  users.users.kise = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDpDOuDyuKLBk1yx1gllddSlS24VazMYx67BAvdajh4T kise@desktop"
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO+Njr/K9t1iQ15NhM852beR+qsMJXRrsJ6KYEM6OheJ kise@laptop"
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOu48S2bzp1N5siaQWGjrObpRY/5hIyCHydT86iCj7N/ kise@phone"
    ];
  };

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  environment.systemPackages = with pkgs; [ git curl vim htop go gnumake ];

  networking.firewall = {
    enable = true;
    allowedTCPPorts = [ 22 ];
  };

  system.stateVersion = "25.11";
}
```

- [ ] **Step 3: VMA を apphost 上でビルド(Mac は aarch64 なので x86_64 ビルドはできない)**

```bash
rsync -a --exclude .git ~/repos/nixos-config-private/ apphost.kisen.one:/tmp/nixos-config-private/
ssh apphost.kisen.one 'cd /tmp/nixos-config-private && nix --extra-experimental-features "nix-command flakes" build .#benchvm-vma && ls -lh result/'
```

Expected: `result/vzdump-qemu-benchvm-*.vma.zst` ができる(数分)。

- [ ] **Step 4: eevee へ転送して restore**

```bash
scp apphost.kisen.one:/tmp/nixos-config-private/result/vzdump-qemu-benchvm-*.vma.zst /tmp/
scp /tmp/vzdump-qemu-benchvm-*.vma.zst root@192.0.2.10:/var/lib/vz/dump/
ssh root@192.0.2.10 '
  qmrestore /var/lib/vz/dump/vzdump-qemu-benchvm-*.vma.zst 9200 --unique true --storage local-zfs
  qm set 9200 --net0 virtio,bridge=vmbr0 --net1 virtio,bridge=team1 --net2 virtio,bridge=team2 \
    --cores 4 --memory 4096 --onboot 1 --name benchvm
  qm start 9200
'
```

- [ ] **Step 5: 検証**

```bash
ssh root@192.0.2.10 'sleep 20; qm guest exec 9200 -- bash -c "hostname && hostname -I"'
# 出力された 192.0.2.x に対して:
ssh kise@192.0.2.x 'hostname && ip -4 addr show ens19 | grep inet'
```

Expected: hostname `benchvm`、ens19 に `10.100.1.2/24`。
インターフェース名が ens18/19/20 でない場合: benchvm 内で `ip link` を見て configuration.nix の名前を合わせ、Step 3 から再実行(旧 9200 は `qm destroy 9200` してから)。実際の名前をこの計画にメモすること。

- [ ] **Step 6: nixos-config-private をコミット**

そのリポジトリの流儀でコミット(例: `benchvm: INUCON ベンチ VM を追加`)。

---

### Task 6: チーム VM 払い出し(Terraform)

**Files:**
- Create: `infra/team-vms.tf`, `infra/templates/team-user-data.yaml.tftpl`

**Interfaces:**
- Consumes: tpl-private-isu 9100(Task 4)、VNet team1/2(Task 2)、`var.teams`
- Produces: VM `inucon-team1-1`(vmid 1101, 10.100.1.11)、`inucon-team2-1`(vmid 1201, 10.100.2.11)。isucon ユーザーにチームメンバーの GitHub 鍵で SSH 可能

- [ ] **Step 1: user-data テンプレート作成**

`infra/templates/team-user-data.yaml.tftpl`:

```yaml
#cloud-config
hostname: ${hostname}
users:
  - name: isucon
    groups: [sudo]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
%{ for key in ssh_keys ~}
      - ${key}
%{ endfor ~}
```

(isucon ユーザーはテンプレート内に既存。cloud-init の users モジュールは既存ユーザーには鍵とグループの適用のみ行う。GitHub 鍵は TF 側で取得して埋め込む — VM 内から GitHub への到達に依存させない)

- [ ] **Step 2: team-vms.tf 作成**

```hcl
locals {
  team_instances = merge([
    for tnum, t in var.teams : {
      for i in range(1, t.instances + 1) :
      "team${tnum}-${i}" => {
        team         = tnum
        vmid         = 1000 + tonumber(tnum) * 100 + i
        ip           = "10.100.${tnum}.1${i}"
        github_users = t.github_users
      }
    }
  ]...)

  all_github_users = toset(flatten([for t in var.teams : t.github_users]))
}

data "http" "github_keys" {
  for_each = local.all_github_users
  url      = "https://github.com/${each.key}.keys"
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
      ssh_keys = distinct(flatten([
        for u in each.value.github_users :
        split("\n", trimspace(data.http.github_keys[u].response_body))
      ]))
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
```

- [ ] **Step 3: apply(クローン時間を計測)**

```bash
cd infra && time terraform apply
```

Expected: VM 2 台 created。`time` の実測値を後で spec 更新(Task 9)に使うので記録。

- [ ] **Step 4: 検証(起動・アプリ・SSH 鍵・SNAT・分離)**

```bash
ssh root@192.0.2.10 '
  qm guest exec 1101 -- cloud-init status
  curl -s -o /dev/null -w "team1-1 app: %{http_code}\n" http://10.100.1.11/
  curl -s -o /dev/null -w "team2-1 app: %{http_code}\n" http://10.100.2.11/
  qm guest exec 1101 -- bash -c "cat /home/isucon/.ssh/authorized_keys | wc -l"
  qm guest exec 1101 -- bash -c "curl -s -o /dev/null -w \"outbound: %{http_code}\" https://github.com"   # SNAT
  qm guest exec 1101 -- bash -c "ping -c1 -W2 10.100.2.11 || echo ISOLATED"                              # チーム間分離
'
```

Expected: cloud-init `done`、app 両方 `200`、authorized_keys 1 行以上、outbound `200`、最後に `ISOLATED`。

- [ ] **Step 5: コミット**

`/commit`(例: `infra: チーム VM 払い出しを Terraform 化`)。

---

### Task 7: ベンチ実行検証(benchvm → team1-1)

**Files:**
- Modify: `problems/private-isu/README.md`(ベンチ手順と実測を追記)

**Interfaces:**
- Consumes: benchvm(Task 5)、inucon-team1-1 = 10.100.1.11(Task 6)
- Produces: 「benchvm からベンチを実行してスコアを得る」再現手順(Phase 2 のランナー/アダプタ実装の入力になる)

- [ ] **Step 1: benchvm にベンチマーカーをビルド**

```bash
ssh kise@<benchvm の LAN IP> '
  git clone --depth 1 https://github.com/catatsuy/private-isu.git
  cd private-isu/benchmarker
  cat README.md   # ビルド・実行手順と userdata の場所が下記想定と違わないか確認
  make
  ls bin/ userdata/
'
```

Expected: `bin/benchmarker` と `userdata/`(画像データ)ができる。README の手順が想定と違った場合は正をこの計画と README.md に反映。

- [ ] **Step 2: ベンチ実行**

```bash
ssh kise@<benchvm の LAN IP> '
  cd private-isu/benchmarker
  time ./bin/benchmarker -u ./userdata -t http://10.100.1.11
'
```

Expected: JSON が出力され `"pass": true`、`"score"` が 0 より大きい。実行時間(通常 60〜75 秒)・スコア・fail 数を記録。
`pass: false` の場合: メッセージを確認。`/initialize` タイムアウトなら 2vCPU/4GB でのスペック不足を意味する(スペックのリスク項目)— team VM を一時的に 4vCPU にして再測し、結果を README に記録。

- [ ] **Step 3: ベンチ中のホスト負荷を観察**

ベンチをもう一度流しながら、別ターミナルで:

```bash
ssh root@192.0.2.10 'top -b -n3 -d5 | head -20; free -h'
```

Expected: CPU がベンチ+対象 VM で張り付いても apphost が窒息していないこと。観察結果を README に記録。

- [ ] **Step 4: README 更新とコミット**

`problems/private-isu/README.md` に: ベンチのビルド・実行コマンド、スコア、実行時間、`/initialize` の可否、ホスト負荷の所見。

`/commit`(例: `problems: private-isu ベンチの実行手順と実測を記録`)。

---

### Task 8: Cloudflare Tunnel + Access(外部 SSH)

**Files:**
- Modify: `~/repos/nixos-config-private/hosts/benchvm/configuration.nix`(cloudflared 追加)
- Modify: `~/repos/nixos-config-private/secrets/secrets.nix`(新 secret 登録)
- Create: `~/repos/nixos-config-private/secrets/cloudflared-inucon.age`
- Create: `infra/docs/cloudflare-setup.md`(ダッシュボード手順 runbook)

**Interfaces:**
- Consumes: benchvm(Task 5)、チーム VM(Task 6)
- Produces: `inucon-team1-1.kisen.one` / `inucon-team2-1.kisen.one` への Access 制御付き SSH。参加者向け `~/.ssh/config` サンプル

- [ ] **Step 1: トンネル作成(benchvm 上で一時的に)**

```bash
ssh kise@<benchvm の LAN IP>
nix shell nixpkgs#cloudflared
cloudflared tunnel login       # 表示された URL をブラウザで開いて kisen.one を選択
cloudflared tunnel create inucon
ls ~/.cloudflared/             # <TUNNEL_UUID>.json ができる。UUID を控える
cloudflared tunnel route dns inucon inucon-team1-1.kisen.one
cloudflared tunnel route dns inucon inucon-team2-1.kisen.one
```

Expected: DNS ルート 2 件が作成される(CNAME → `<UUID>.cfargotunnel.com`)。

- [ ] **Step 2: credential を agenix 化**

`secrets/secrets.nix` に benchvm のホスト鍵を let に追加し、新エントリを足す:

```nix
let
  # ...既存 5 鍵はそのまま...
  benchvm-host   = "<ssh kise@<benchvm> 'cat /etc/ssh/ssh_host_ed25519_key.pub' の出力>";
in {
  # ...既存 3 エントリはそのまま...
  "cloudflared-inucon.age" = { publicKeys = [ benchvm-host apphost-kise macos desktop redmi5g-termux ]; };
}
```

apphost 上(agenix コマンドがある)で暗号化:

```bash
cd /tmp/nixos-config-private/secrets
agenix -e cloudflared-inucon.age   # <TUNNEL_UUID>.json の中身を貼り付けて保存
# できた .age を手元リポジトリへ回収:
# scp apphost.kisen.one:/tmp/nixos-config-private/secrets/cloudflared-inucon.age ~/repos/nixos-config-private/secrets/
```

- [ ] **Step 3: benchvm の configuration.nix に cloudflared を追加**

```nix
  age.secrets.cloudflared-inucon = {
    file = ../../secrets/cloudflared-inucon.age;
    owner = "root";
  };

  services.cloudflared = {
    enable = true;
    tunnels."<TUNNEL_UUID>" = {   # Step 1 で控えた UUID に置換
      credentialsFile = config.age.secrets.cloudflared-inucon.path;
      default = "http_status:404";
      ingress = {
        "inucon-team1-1.kisen.one" = "ssh://10.100.1.11:22";
        "inucon-team2-1.kisen.one" = "ssh://10.100.2.11:22";
      };
    };
  };
```

再デプロイは VMA 再ビルドではなく benchvm 上での `nixos-rebuild switch` で行う(2 回目以降の変更反映はこれが最短):

```bash
rsync -a --exclude .git ~/repos/nixos-config-private/ kise@<benchvm の LAN IP>:/tmp/nixos-config-private/
ssh kise@<benchvm の LAN IP> 'sudo nixos-rebuild switch --flake /tmp/nixos-config-private#benchvm'
```

Expected: `systemctl list-units | grep cloudflared` で tunnel サービスが active。

- [ ] **Step 4: Cloudflare Access 設定(ダッシュボード手動、runbook に記録)**

[one.dash.cloudflare.com](https://one.dash.cloudflare.com) で:

1. Settings → Authentication → Login methods → **GitHub を追加**(GitHub OAuth App を作って Client ID/Secret を登録)
2. Access → Applications → **Add an application → Self-hosted**: domain `inucon-team1-1.kisen.one`、Policy: Allow / Include: Emails = team1 メンバーのメールアドレス(GitHub アカウントのメール)
3. 同様に `inucon-team2-1.kisen.one` を team2 メンバーで作成

手順・スクリーンショットなしの文字記録を `infra/docs/cloudflare-setup.md` に残す。

- [ ] **Step 5: 参加者視点の検証(Mac から)**

`~/.ssh/config` に追加:

```
Host inucon-*.kisen.one
  ProxyCommand cloudflared access ssh --hostname %h
  User isucon
```

```bash
ssh inucon-team1-1.kisen.one hostname
```

Expected: 初回はブラウザが開いて GitHub 認証 → 成功後 `inucon-team1-1` が返る。**未許可アカウントで拒否されることも確認**(別 GitHub アカウントか、policy から自分を外して一時確認)。

- [ ] **Step 6: コミット**

nixos-config-private をそのリポジトリの流儀でコミット。inucon リポジトリは `/commit`(例: `docs: Cloudflare Tunnel/Access の設定 runbook を追加`)。

---

### Task 9: 実測の反映と Phase 1 クローズ

**Files:**
- Modify: `docs/superpowers/specs/2026-07-04-inucon-design.md`(リスク・未確認事項の検証結果反映、リソース実測反映)
- Create: `README.md`(リポジトリトップ: 何があるか、Phase 1 の使い方)

**Interfaces:**
- Consumes: Task 1〜8 の全実測値
- Produces: Phase 2(ポータル)計画の前提となる確定情報

- [ ] **Step 1: spec のリスク欄を検証結果で更新**

「リスク・未確認事項」の各項目に結果を追記: matsuu cloud-config の Proxmox 動作(結果と所要時間)、RAM 内訳(ARC だったか)、`/initialize` 実測、クローン実測時間。リソース計画表を実測値で更新。

- [ ] **Step 2: README.md 作成**

リポジトリ構成(spec の「リポジトリ構成」章の実体)、Phase 1 でできること(ベンチの回し方 1 コマンド、チーム VM の増減 = `var.teams` の `instances` を変えて `terraform apply`)、spec/plan へのリンク。

- [ ] **Step 3: コミットして PR**

`/commit`(例: `docs: Phase 1 の実測結果を spec に反映し README を追加`)→ ブランチ全体を `/pr` → `/pr-review`。

---

## 実行順序と依存

```
Task 1 (eevee 整備)
  ├─> Task 2 (TF + SDN) ──> Task 5 (benchvm) ─┐
  ├─> Task 3 (base tpl) ─> Task 4 (問題 tpl) ─┴─> Task 6 (チーム VM) ─> Task 7 (ベンチ) ─> Task 8 (CF Access) ─> Task 9 (クローズ)
```

Task 2/3 は並行可。Task 5 は Task 2 完了後ならいつでも。

## この計画で実証されるスペックのリスク項目

| リスク項目 | 検証タスク |
|---|---|
| matsuu cloud-config が Proxmox で動くか | Task 4 |
| RAM 14GB 使用の内訳(ARC 仮説) | Task 1 |
| 縮小スペック(2vCPU/4GB)で `/initialize` が通るか | Task 7 |
| linked clone の所要時間 | Task 6 |
| ベンチ中のホスト負荷・公平性の感触 | Task 7 |
