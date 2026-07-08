# INUCON

INUCON (Isucon aNd Unified Compute Operations Node) は、自宅の Proxmox サーバー上に
複数チーム参加型の ISUCON 競技環境(ポータル・ベンチマーカー・参加者サーバー払い出し)を
再現するプロジェクトです。副次目的として、参加者サーバー払い出し層を汎用の「ミニ IaaS」
として設計し、競技以外の普段使いにも使えるようにします。

設計の背景・全体アーキテクチャ・フェーズ計画は設計ドキュメントを参照してください:
[docs/superpowers/specs/2026-07-04-inucon-design.md](docs/superpowers/specs/2026-07-04-inucon-design.md)

## 現状: Phase 1(手動 MVP)完了 (2026-07-08)

ポータルはまだ無く、Terraform + シェルスクリプトによる手動オペレーションの範囲で、
INUCON の全インフラ要素(問題テンプレート構築・チーム VM 払い出し・ネットワーク分離・
外部 SSH アクセス・ベンチ実行)が一通り動作することを確認済みです。

Phase 1 で確認済みのこと:

- private-isu(Pixiv 社内 ISUCON 2016)の問題テンプレートを Proxmox 上に構築し、
  縮小スペック(2vCPU/4GB)でベンチマーカーが安定して通ること(3 回連続 `pass:true`、
  score 1032/1030/1041、fail:0)
- Terraform でのチーム VM 払い出し(linked clone、2 台で約 19 秒)と `var.teams` の
  `instances` を変えるだけでの台数増減(0〜3 台)
- Proxmox SDN によるチーム間ネットワーク分離(相互に到達不可)
- Cloudflare Tunnel + Access 経由での、VPN 不要な外部からのチーム SSH アクセス

実測値・検証結果の詳細はすべて設計ドキュメントの「リスク・未確認事項」節と
「リソース計画」節、および `infra/docs/` 配下の runbook に記録されています。

Phase 2(ポータル)以降の計画は設計ドキュメントの「フェーズ計画」節を参照してください。
本 README では Phase 1 時点でできることのみを扱います。

## リポジトリ構成

```
infra/     Terraform(テンプレート・チーム VM・SDN の定義)、eevee 等の runbook (infra/docs/)
problems/  問題テンプレートの構築手順(cloud-config)とアダプタ
docs/      設計ドキュメント・実装計画
```

`portal/`(ポータル)・`runner/`(ベンチランナー)・`deploy/`(k3s マニフェスト)は
Phase 2 以降に追加される予定です(現時点では未着手)。

サーバー自体の宣言的構成(NixOS)は別リポジトリ `nixos-config-private` の
`hosts/{apphost,benchvm}` で管理しています。

## 命名規則

- 物理/基盤: `eevee`(Proxmox ホスト、192.0.2.10)、`apphost`(ポータル + 既存サービス、
  既存 VM)、`benchvm`(ベンチランナー、192.0.2.5)。
- 競技 VM: `inucon-team{N}-{M}`(例: `inucon-team1-1`)
- 外部公開ホスト名: `inucon-team{N}-{M}.kisen.one`(kisen.one 直下のフラット命名)

## Phase 1 でできること

### 問題テンプレートの構築(private-isu)

```bash
scp problems/private-isu/user-data.build.yaml root@192.0.2.10:/var/lib/vz/snippets/private-isu-build.yaml
ssh root@192.0.2.10 'bash -s' < problems/private-isu/build-template.sh
ssh root@192.0.2.10 'bash -s' < problems/private-isu/patch-app.sh      # ベンチ失敗の恒久修正(必須)
ssh root@192.0.2.10 'bash -s' < problems/private-isu/finalize-template.sh
```

詳細・恒久修正パッチの根本原因は
[problems/private-isu/README.md](problems/private-isu/README.md) を参照。

### チーム VM の増減

`infra/variables.tf` の `var.teams` でチームごとの `instances`(0〜3)を変更して
`terraform apply` するだけです(linked clone のため数十秒で反映されます)。

```hcl
variable "teams" {
  default = {
    "1" = { github_users = ["<GitHub アカウント>"], instances = 1 }
    "2" = { github_users = ["<GitHub アカウント>"], instances = 1 }
  }
}
```

### ベンチ実行

benchvm(ベンチランナー)から対象チーム VM に向けて実行します(例: team1-1 = `10.100.1.11`):

```bash
cd ~/private-isu/benchmarker
./bin/benchmarker -u ./userdata -t http://10.100.1.11
```

ビルド手順・実測結果は
[problems/private-isu/README.md](problems/private-isu/README.md) を参照。

### 参加者の外部 SSH アクセス

```bash
ssh inucon-team1-1.kisen.one
```

参加者側の設定(`~/.ssh/config` 等)と Cloudflare Access の運用は
[infra/docs/cloudflare-setup.md](infra/docs/cloudflare-setup.md) を参照。

## 開催前 TODO

- **許可リスト外アカウントでの拒否の実測**: 現状 Cloudflare Access の default-deny という
  設計保証のみで、許可リストに無いアカウントでログインした場合に実際に拒否されることは
  未検証。身内開催の前に別アカウントで一度確認すること
  ([infra/docs/cloudflare-setup.md](infra/docs/cloudflare-setup.md) 参照)。

## 主要ドキュメント

- 設計: [docs/superpowers/specs/2026-07-04-inucon-design.md](docs/superpowers/specs/2026-07-04-inucon-design.md)
- Phase 1 実装計画: [docs/superpowers/plans/2026-07-05-phase1-manual-mvp.md](docs/superpowers/plans/2026-07-05-phase1-manual-mvp.md)
- runbook 群: [infra/docs/](infra/docs/)(eevee 整備、チーム間分離、Cloudflare Tunnel/Access)
- 問題テンプレート: [problems/private-isu/README.md](problems/private-isu/README.md)
