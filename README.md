# INUCON

INUCON (Isucon aNd Unified Compute Operations Node) は、自宅の Proxmox サーバー上に
複数チーム参加型の ISUCON 競技環境(ポータル・ベンチマーカー・参加者サーバー払い出し)を
構築するプロジェクトです。副次目的として、参加者サーバー払い出し層を汎用の「ミニ IaaS」
として設計し、競技以外の普段使いにも使えるようにします。

設計の背景・全体アーキテクチャ・フェーズ計画は設計ドキュメントを参照してください:
[docs/superpowers/specs/2026-07-04-inucon-design.md](docs/superpowers/specs/2026-07-04-inucon-design.md)

## 現状: Phase 3(セルフサービス + 招待自動化)完了・本番稼働中 (2026-07-18)

ポータルが https://inucon.kisen.one で稼働しています(GitHub OAuth ログイン)。

- **Phase 1**(2026-07-08): Terraform + 手動オペレーションで全インフラ要素を検証
  (問題テンプレート・チーム VM 払い出し・SDN 分離・Cloudflare Tunnel/Access 経由の
  外部 SSH・ベンチ実行)
- **Phase 2**(2026-07-10): ポータル(スコアボード・ベンチ実行キュー・チーム管理)と
  ベンチランナーを本番デプロイ
- **Phase 3**(2026-07-18): セルフサービスインスタンス管理(Team ページからの VM
  追加/削除、約20秒で払い出し)+ メンバー招待の自動化(ポータル所属 + Cloudflare
  Access + SSH 鍵注入の3点セット)+ UI リスタイル

Phase 3 でできること:

- チームメンバーが Team ページから自分たちの競技 VM を追加・削除できる
  (quota / RAM / 進行中ガード付き。払い出しは linked clone + PVE ネイティブ
  cloud-init、撤収は VM/DNS/Access/tunnel ingress まで自動掃除)
- admin が招待(githubLogin + email)を発行すると、ポータル所属・Cloudflare Access
  許可・全 running VM への SSH 鍵注入までワンアクションで済む
- ベンチはインスタンス選択で実行(コンテスト running 中のみ、チームごと直列、
  グローバル同時 1 本)

実機検証の記録:
[docs/superpowers/reviews/2026-07-18-phase3-task7-verification.md](docs/superpowers/reviews/2026-07-18-phase3-task7-verification.md)

## ブランチ運用

- **develop**(default): 開発のベース。タスクごとのブランチ → PR → develop にマージ。
- **main**: 本番同期用。**本番(apphost の k3s)は常に main と同一内容**。
  develop → main の PR マージ = デプロイ意思表示(手順は
  [deploy/README.md](deploy/README.md))。

## リポジトリ構成

```
portal/        ポータル本体(TypeScript + Effect.ts、DDD 3層: domain/application/infrastructure)
portal/web/    ポータル SPA(React + Vite)
runner/        ベンチランナー(benchvm 上の systemd サービス)
shared/        ポータル/ランナー間の HTTP API 契約(スキーマが正)
deploy/        Dockerfile・k3s マニフェスト・デプロイ runbook
infra/         Terraform(テンプレート・Phase 1 チーム VM・SDN)、eevee 等の runbook (infra/docs/)
problems/      問題テンプレートの構築手順(private-isu)
docs/runbooks/ 運営 runbook(コンテスト当日の作業)
docs/superpowers/  設計・実装計画・検証記録(SDD の成果物)
```

サーバー自体の宣言的構成(NixOS)は別リポジトリ(private)の管理です。

## 命名規則

- 物理/基盤: `eevee`(Proxmox ホスト)、`apphost`(ポータル + 既存サービス)、
  `benchvm`(ベンチランナー)。
- 競技 VM: `inucon-team{N}-{M}`(vmid = 1000 + N*100 + M、IP = 10.100.N.1M)
- 外部公開ホスト名: `inucon-team{N}-{M}.kisen.one`(kisen.one 直下のフラット命名)

## 開発

```bash
pnpm install
pnpm -r typecheck   # 全ワークスペース型チェック
pnpm -r test        # 全テスト(portal は :memory: SQLite で本番マイグレーション込み)
pnpm --filter web dev   # SPA 開発サーバー(/api は localhost:3000 の portal へプロキシ)
pnpm --filter portal dev
```

## 主要ドキュメント

- 設計: [docs/superpowers/specs/2026-07-04-inucon-design.md](docs/superpowers/specs/2026-07-04-inucon-design.md)
- Phase 3 設計(セルフサービス/招待): [docs/superpowers/specs/2026-07-10-phase3-selfservice-design.md](docs/superpowers/specs/2026-07-10-phase3-selfservice-design.md)
- デプロイ runbook(本番 = main 運用): [deploy/README.md](deploy/README.md)
- コンテスト運営 runbook: [docs/runbooks/contest-operations.md](docs/runbooks/contest-operations.md)
- リカバリ runbook(block condition からの復旧): [docs/runbooks/contest-recovery.md](docs/runbooks/contest-recovery.md)
- Phase 1 の手動オペレーション(Terraform での VM 増減等): [infra/docs/](infra/docs/) と
  [problems/private-isu/README.md](problems/private-isu/README.md)
