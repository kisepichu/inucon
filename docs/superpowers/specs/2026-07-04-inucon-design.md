# INUCON 設計ドキュメント

日付: 2026-07-04
ステータス: 承認済み (2026-07-05) / **Phase 1 完了 (2026-07-08)**

Phase 1(手動 MVP)は 2026-07-08 に完了した。実測・検証結果は「リスク・未確認事項」節と「リソース計画」節に追記済み。以後 Phase 2(ポータル)の設計・実装に進む。

## 背景・目的

AI の登場で ISUCON の競技性は「当日手でチューニングを詰める」ことから「当日までに計測・チューニングを自動化する仕組みを作り込む」ことへ変化した。その仕組みを試すには繰り返し使える競技環境が必要だが、AWS はコストがかかる。そこで自宅の Proxmox サーバー上に、複数チームが参加できる ISUCON 競技全体(ポータル・ベンチマーカー・参加者サーバー払い出し)を再現し、身内で ISUCON を開催できるようにする。

副次目的として、参加者サーバー払い出し層を汎用の「ミニ IaaS」として設計し、競技以外の普段使い(AI エージェントに VM を切らせて自由に開発・デプロイさせる等)にも使えるようにする。

名称: **INUCON** (Isucon aNd Unified Compute Operations Node)。

## スコープ

**含む:**

- 競技ポータル(チーム管理、ベンチキュー、スコアボード、インスタンス管理 UI)
- ベンチランナー(ジョブ取得→ベンチ実行→結果送信)
- VM 払い出し層(Proxmox API によるクローン・削除、cloud-init、ネットワーク分離)
- 外部参加者のアクセス経路(Cloudflare Tunnel + Access)
- 問題パッケージの仕組み(初期対応: private-isu 1 問)

**含まない:**

- 競技当日に自作ツールを問題へ一発適用するエージェント側の仕組み(参加者側ツールであり独立プロジェクト)
- 問題の自作
- 本家 AWS との完全互換(AWS API 再現はしない。LocalStack 等は調査の結果不適合と判断)

## 前提環境(調査済みの事実)

- Proxmox VE ホスト **eevee** (192.0.2.10): AMD Ryzen 5 6600H、6 コア 12 スレッド、RAM 28.13GB(現在約 14GB 使用、内訳は要確認)、ストレージ `local`(Directory 型)+ `local-zfs`(ZFS、VM ディスク用)
- 既存 VM **apphost** (192.0.2.20): NixOS、4vCPU/8GB。k3s(qkjudge 稼働中)、cloudflared tunnel(`apphost.kisen.one` = SSH)、GitHub Actions self-hosted runner。構成は `nixos-config-private/hosts/apphost`
- ドメイン `kisen.one` は Cloudflare 管理。無料プランのため Universal SSL は 1 階層サブドメインまで(sub-subdomain 不可)
- 過去問資産: [matsuu/cloud-init-isucon](https://github.com/matsuu/cloud-init-isucon)(ISUCON10〜14, private-isu 等の cloud-config 集)、本家リポジトリ(問題・ベンチ・Ansible が MIT 公開)
- 参考アーキテクチャ: [piscon-portal-v2](https://github.com/traPtitech/piscon-portal-v2)(DB FIFO キュー + ランナーがポーリング + インスタンス管理の抽象化。活発に開発中だが traQ OAuth 前提のため fork せず構造のみ参考にする)

## 決定事項サマリ

| 項目           | 決定                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| 規模           | 2〜3 チーム、1 チーム 0〜3 インスタンス(実装は n チーム対応、実運用は eevee の RAM が上限) |
| ベンチ実行     | キュー + 順番実行(同時 1 本)。本家と同方式                                                 |
| VM 払い出し    | Proxmox API + テンプレート linked clone + cloud-init。AWS エミュレータは使わない           |
| ポータル       | 自作。TypeScript + Effect.ts、DDD。apphost の k3s にデプロイ                               |
| ベンチマーカー | 過去問同梱のバイナリをそのまま使う(ベンチの性質は問題の一部)。問題ごとにアダプタを書く     |
| 外部アクセス   | Cloudflare Tunnel + Access。VPN には入れない                                               |
| ホスト名       | フラット命名 `inucon-*.kisen.one`(sub-subdomain は無料プランで TLS 不可のため)             |
| 認証           | GitHub OAuth(SSH 鍵も GitHub 登録鍵を流用するため一貫する)                                 |

> **Phase 1 での逸脱注記(2026-07-08)**: 上記「認証」はポータル(Phase 2)の GitHub OAuth を指し、これは変更なし。一方 Cloudflare **Access**(チーム SSH の認可)は当初想定した「GitHub IdP」を Phase 1 では採用せず、既存 Zero Trust 組織(`example.cloudflareaccess.com`)のログイン方式 + メール許可リストで運用した(GitHub OAuth App 新規作成というブラウザ作業を避けるため。詳細: `infra/docs/cloudflare-setup.md` の設計メモ)。IdP を GitHub に切り替える必要が生じたら開催前に追加する。

## 全体アーキテクチャ

```
[参加者] ──cloudflared access(SSH)──> Cloudflare edge ──tunnel──> benchvm ──> チーム VM
[参加者] ──HTTPS──────────────────> Cloudflare edge ──tunnel──> apphost ──> ポータル

eevee (Proxmox, 6C12T/28GB)
├ apphost   既存 4vCPU/8GB  : ポータル(k3s) + qkjudge ほか既存サービス
├ benchvm   4vCPU/4GB       : ベンチランナー常駐 + cloudflared(チーム SSH の ingress)
│                             NIC を全チーム VNet に持つ
├ inucon-team1-1 .. 2vCPU/4GB/20GB : 競技 VM(問題テンプレートから linked clone)
├ inucon-team2-1 ..                : 同上
├ inucon-<app>                     : 普段使い VM(競技外、同じ払い出し層を使う)
└ templates: tpl-private-isu, (tpl-isucon13, ...)

ネットワーク: Proxmox SDN Simple zone でチームごとに VNet(例: team1 = 10.100.1.0/24)。
チーム間・自宅 LAN とは分離。benchvm のみ全 VNet に足を持つ。
```

## コンポーネント設計

### 1. VM 払い出し層(ミニ IaaS)

- **テンプレート作成**: matsuu/cloud-init-isucon の cloud-config を Ubuntu cloud イメージに一度流して問題環境を構築し(初回 10 分超)、`qm template` 化。以後はチーム分を linked clone(数秒)で払い出す。テンプレート化時に machine-id / SSH ホスト鍵のリセットを行う。
- **静的 IaC(Terraform, bpg/proxmox provider)**: テンプレート、benchvm、SDN Zone/VNet などの土台。リポジトリの `infra/` に置く。
- **動的払い出し(ポータルから)**: Terraform ではなく Proxmox API を直接叩く(clone / status / destroy)。インスタンス追加ボタンの実体。
- **cloud-init 注入**: チームメンバーの GitHub アカウントから `ssh_import_id: gh:<user>` で SSH 鍵を投入。IP は静的割り当て(`10.100.<team>.1<n>` = team{N}-{n} の規則)。snippets は `local` ストレージ(Content に Snippets を追加)+ `cicustom` で渡す。
- **ガード**: (1) チームごとのインスタンス上限(コンテスト設定、全チーム同数)、(2) クローン前に Proxmox API でホスト空き RAM を確認し不足なら拒否、(3) VM スペックは固定(2vCPU/4GB)でチーム間の同一性を保証。
- **普段使い**: 同じ払い出し層で `inucon-<app>` VM を作れる。競技用と同じ仕組みの別テナント扱い。

### 2. ネットワークとアクセス

- **分離**: SDN Simple zone + チーム別 VNet。チーム A からチーム B・自宅 LAN へは到達不可。ベンチトラフィックは VNet 内で完結し、物理 NIC を経由しない(公平性)。
- **SSH**: cloudflared(benchvm 同居)の ingress に `inucon-team1-1.kisen.one → ssh://10.100.1.11:22` を登録。Cloudflare Access ポリシーで「そのホスト名はそのチームのメンバーのみ」に制限(GitHub IdP)。参加者は `cloudflared access ssh` の ProxyCommand 設定で接続。VPN には一切入れない。
- **自動化**: DNS レコード・tunnel ingress・Access ポリシーはすべて Cloudflare API で操作可能。インスタンス追加/削除時にポータルが更新する。
- **アプリの動作確認**: 参加者は SSH ポートフォワード(`ssh -L`)で行う(HTTP 公開はしない。必要になったら Access 付きホスト名を追加検討)。

### 3. ポータル(apphost k3s 上)

- **技術**: TypeScript + Effect.ts、DDD。DB は SQLite(@effect/sql、身内規模で十分。PVC に置く)。フロントは同リポジトリ(フレームワークは実装計画時に選定)。認証は GitHub OAuth。
- **ドメインモデル(集約の候補)**: Contest(問題・チーム上限・インスタンスクォータ)/ Team(メンバー = GitHub アカウント)/ Instance(VM の状態機械: creating → running → stopped → deleting)/ BenchJob(FIFO キュー: queued → running → finished/failed、スコア・ログを保持)。
- **ベンチキュー**: DB 上の FIFO。チームごと同時 1 本(本家仕様)+ 全体でも同時 1 本(順番実行)。
- **インスタンス管理**: 追加/削除ボタン。裏側は「Proxmox clone → cloud-init 設定 → 起動 → Cloudflare DNS/ingress/Access 登録」のオーケストレーション。途中失敗時は補償処理(作りかけ VM の削除、DNS 巻き戻し)。Effect の acquireRelease / retry が活きる部分。
- **ベンチ対象の指定**: チームのインスタンスをドロップダウン選択 + ip:port 直接入力。**入力 IP はそのチームの VNet サブネット内のみ許可**(外部 IP へのベンチは DoS 装置化・WAN レイテンシでスコア無意味・家庭回線圧迫のため禁止)。
- **スコアボード**: チームごとの最新/最高スコア、ベンチ履歴、ログ表示。

### 4. ベンチランナー(benchvm)

- **構成**: NixOS(`nixos-config-private/hosts/benchvm`)。ランナーはポータルと同じ TS で書き型を共有。
- **フロー**: ポータルの API を HTTP ポーリング(shared token 認証)→ ジョブ取得 → 問題アダプタ経由でベンチバイナリを対象 IP に実行 → 進捗ログを逐次 POST → 終了時にスコア・結果を POST。
- **問題アダプタ**: 「問題 = テンプレート ID + アダプタ」のデータとして扱う。アダプタは「ベンチバイナリの起動コマンド + stdout からスコア/合否を抽出して JSON にする」薄いスクリプト。1 問追加 = テンプレート構築 + アダプタ数十行。
- **リソース**: ベンチ側がボトルネックになるとスコアが頭打ちになり計測が壊れるため、benchvm には競技 VM の倍(4vCPU)を割り当てる。順番実行なので 1 台でよい。

### 5. 問題パッケージ(初期対応)

- **Phase 1 は private-isu 1 問**(定番・書籍題材・ドキュメント豊富)。2 問目(ISUCON13 or 14 あたり)で抽象の正しさを検証する。
- 注意: matsuu の cloud-init はベンチとアプリが同居する練習用構成。競技ではベンチを benchvm から撃つため、ベンチバイナリ+初期データを benchvm 側に別途配置する(本家リポジトリ / ansible-isucon から取得)。

## 公平性の設計

- チーム間: VM スペック固定・同一テンプレート・ベンチ順番実行・ベンチトラフィックはホスト内で完結。
- スペックは本家(c5.large = 2vCPU/4GB)と同等の 2vCPU/4GB を標準とする。RAM を 2GB に下げると初期データロードや `/initialize` のタイムアウトでベンチが FAIL するリスクがあるため下げない。CPU を下げるのはスコアが下がるだけで比較的安全だが、下げる場合は問題ごとに動作確認する。
- 普段使い VM との同居: 完全な公平性は同一物理ホストでは不可能。運用ルール「開催中は重い私用 VM を止める」で割り切る。厳密化(CPU ピニング、ISUCON10 本家方式)は Phase 4。

## リソース計画(eevee: 12 スレッド / 28GB)

| 構成                    | vCPU 合計                | RAM 合計                |
| ----------------------- | ------------------------ | ----------------------- |
| apphost(既存)           | 4                        | 8GB                     |
| benchvm                 | 4                        | 4GB                     |
| 競技 VM 2 チーム × 2 台 | 8                        | 16GB                    |
| **合計**                | 16(オーバーコミット許容) | **28GB ← 上限ちょうど** |

- RAM が制約。現在の使用 14GB の内訳確認と、開催時に不要 VM を止める運用が前提。0〜3 台の動的追加/削除はこの制約下でむしろ合理的(使う分だけ確保)。
- vCPU はアイドル VM が多いためオーバーコミット許容。ベンチ実行中のみ対象チーム VM + benchvm が CPU を使う。
- ディスク: linked clone のため競技 VM の増分はわずか。local-zfs の空きは十分(1.79TB 中ほぼ未使用)。

### 実測(2026-07-08、Phase 1 完了時点)

- **eevee 実メモリ**: 28.1GiB(前提節の「約 28GB」を実測で確認)。使用中 14GiB の内訳は
  apphost 8GiB + ZFS ARC 3.7GiB + PVE ホスト約 2GiB(下記リスク項目 2 の検証結果)。
  ARC 上限を PVE インストーラ既定の 6GiB から **4GiB に変更・`/etc/modprobe.d/zfs.conf` に統合**
  (`infra/docs/eevee-setup.md`)。この変更後、Phase 1 のフル構成
  (apphost 8G + benchvm 4G + チーム VM 4G×2 = 20G + ARC 4G = 24G)は 28.1GiB に問題なく収まった。
- **benchvm**: 起動〜SSH 可能まで約 28 秒(wait-online 無効化前は約 120 秒)。
  ディスクは cloud-init の growPartition で 4.6G → 21G に拡張して運用(ベンチ用画像展開の
  容量不足対策。詳細は `problems/private-isu/README.md` のベンチ実行節)。
- **テンプレート実容量**: `tpl-private-isu`(vmid 9100)は 7.24G(`zfs list` 実測、
  `problems/private-isu/README.md`)。linked clone によるチーム VM 側の追加ディスク使用量は
  わずか。
- **linked clone 所要時間**: チーム VM 2 台の `terraform apply` が 18.9〜19.4 秒。
- **ベンチ実行中のホスト負荷**: eevee は約 81% アイドル・スワップなしで余裕あり(下記リスク
  項目 7 参照)。apphost の既存サービスへの影響は確認されなかった。

## 命名規則

- 物理/基盤: `eevee`(Proxmox ホスト)、`apphost`(ポータル+既存サービス)、`benchvm`(ベンチ)
- 競技 VM: `inucon-team{N}-{M}`、普段使い VM: `inucon-<app>`
- ホスト名: `inucon-team1-1.kisen.one` 等のフラット命名(kisen.one 直下)

## リポジトリ構成

この `inucon` リポジトリに集約する:

```
portal/    ポータル(TS + Effect.ts, DDD)
runner/    ベンチランナー(TS、portal と型共有)
infra/     Terraform(テンプレート・benchvm・SDN・Cloudflare の静的部分)
problems/  問題アダプタ + テンプレート構築手順(cloud-config)
deploy/    apphost k3s へのマニフェスト
docs/      本ドキュメント等
```

サーバー自体の宣言管理(NixOS)は従来どおり `nixos-config-private/hosts/{apphost,benchvm}`。アプリのデプロイ設定はアプリのリポジトリに置く現行の分担を維持する。

## フェーズ計画

- **Phase 1 — 手動 MVP(ポータルなし)**: Terraform + cloud-init で private-isu テンプレート構築 → チーム VM クローン → SDN VNet 分離 → Cloudflare Access 越し SSH 検証 → benchvm から CLI でベンチ実行・スコア確認。ここで「matsuu cloud-config が Proxmox で動くか」「縮小スペックでベンチが通るか」「クローン所要時間」を実証する。
- **Phase 2 — ポータル**: TS + Effect.ts で キュー・スコアボード・チーム管理・GitHub OAuth。benchvm にランナー常駐。この期間の前半に Effect.ts の素振りを兼ねる。
- **Phase 3 — セルフサービス**: インスタンス追加/削除ボタン(Proxmox + Cloudflare API オーケストレーション、クォータ・RAM ガード)。普段使い VM(`inucon-<app>`)の解禁。
- **Phase 4 — 拡張**: 2 問目対応(アダプタ抽象の検証)、1 チーム複数台構成の運用、CPU ピニング等の公平性強化、開催モード(私用 VM の自動停止)。

## リスク・未確認事項

- matsuu/cloud-init-isucon の Proxmox 動作は未検証(汎用 cloud-config なので動く見込みだが Phase 1 冒頭で確認。`cicustom` 使用時は GUI の IP/SSH 鍵設定が無効になるため user-data 側に統合する)
  → **解決済み(2026-07-08)**: 動作した。実ファイルは `private-isu/app.cfg`。qemu-guest-agent
  対応(packages 追加 + runcmd 先頭で enable --now)を統合した cloud-config を snippets +
  `cicustom` で投入し構築成功(ゲスト内実測 803〜822 秒 ≈ 13.4 分、Ansible `ok=93 changed=77
  failed=0`)。フォールバック(ansible-isucon 直接適用)は不要だった。詳細:
  `problems/private-isu/README.md`。
- eevee の使用中 RAM 14GB の内訳が未確認(apphost 8GB + 残り 6GB が何か)
  → **解決済み(2026-07-08)**: ARC 仮説どおり。apphost 8GiB + ZFS ARC 3.7GiB + PVE ホスト
  約 2GiB。ARC 上限は 6GiB(PVE インストーラ設定、`/etc/modprobe.d/zfs.conf` に既存)だった
  ものを 4GiB に変更・統合済み(`infra/docs/eevee-setup.md`)。
- 縮小スペック(特にベンチの `/initialize` タイムアウト)は問題ごとに Phase 1 で実測
  → **解決済み(2026-07-08)**: private-isu について 2vCPU/4GB で通ることを確認。`/initialize`
  通過、3 回連続 `pass:true`(score 1032/1030/1041、fail:0、ばらつき約 1%)、実行時間約 77 秒
  (60 秒本負荷完走)。ただし前提として下記「(新規発見)ベンチ環境バグ」の恒久修正が必要
  だった。
- Effect.ts は学習コストが高い(Phase 1 と並行して素振りする前提)
  → Phase 1(手動 MVP)ではポータルに未着手のため未検証。Phase 2 冒頭で引き続き検証する。
- Cloudflare Access 無料枠は 50 ユーザーまで(身内規模では十分)
  → Phase 1 では Access アプリ 2 件・メール許可ポリシーで運用し、枠超過の懸念は発生しな
  かった(`infra/docs/cloudflare-setup.md`)。
- **(新規発見・2026-07-08)ベンチ環境バグ**: private-isu ベンチマーカー(Go
  `net/http.Client`)が画像投稿 `POST /` への 302 を追従して送る `GET /posts/:id` に、元
  POST の `Content-Type: multipart/form-data; boundary=...` をそのまま引き継ぐ(Go 標準
  ライブラリの既定動作)。一方 Rack 3.2.6 の `Request#form_data?` は HTTP メソッドを見ず
  Content-Type の値だけで multipart 判定するため、ボディの無い GET を multipart 解析しようと
  して `400 Bad Request` になり、ベンチが本負荷フェーズに到達する前に `pass:false` で終了
  する(タイミング非依存・100% 決定的)。nginx リバースプロキシ層で GET/HEAD の
  Content-Type を除去する恒久パッチ(`problems/private-isu/patch-app.sh`)を作成し、
  テンプレートに焼き込んで解決した(再ベンチ 3 回とも `pass:true`)。
- **(新規発見・2026-07-08)チーム間ネットワーク分離**: Proxmox SDN Simple zone はデフォルトで
  は vnet 間ルーティングを遮断しない(zone 分離だけではチーム間到達性が残る)。eevee の
  `FORWARD` チェーンに `10.100.0.0/16 → 10.100.0.0/16 DROP` ルールを追加し、再起動後も
  失われないよう systemd unit(`inucon-team-isolation.service`)で永続化して解決した。
  双方向 ISOLATED であること、および SNAT・ベンチ経路に悪影響がないことを検証済み
  (`infra/docs/team-isolation.md`)。この分離ルールは Terraform 管理外(手動 + systemd
  unit)であり、IaC 化は Issue #6 でフォローアップする。
