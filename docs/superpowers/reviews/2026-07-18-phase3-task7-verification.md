# Phase 3 Task 7 本番検証ログ(2026-07-18)

apphost 本番(k3s namespace inucon, SQLite PVC)への Phase 3 デプロイと実機検証の記録。

## 環境・前提(検証開始時点)

- 本番はそれまで **Phase 2 ポータル**が稼働(pod 8日前 = 2026-07-10 デプロイ)。DB は
  **migration 0001 のみ**。self-service/招待/リスタイルは未デプロイ。
- テストデータ: contest「INUCON」(private-isu, running, quota なし=0001)、
  teams `team1`(#1, member kisepichu)/ `team2-test-name`(#2)、instances 2件
  (`team1-1` 10.100.1.11 / `team2-1` 10.100.2.11、いずれも Phase 1 terraform 製 VM の
  台帳登録、status=active)。孤児 instances = 0。
- 実チーム参加者はおらず、すべて動作確認用。

## ステップ0: マイグレーション・ドライラン(本番を壊さない事前検証)✅

- pod 内で better-sqlite3 `.backup` により整合スナップショットを作成 → ローカルへ取得
  (バックアップ兼用、`~/.claude/jobs/.../portal-prod-snapshot.db`)。
- リポジトリのマイグレータ(`SqliteMigrator.fromFileSystem`)をコピー DB に適用し
  `0001 → 0002 → 0003` を検証:
  - instances 2件が `active → running`、**vmid 正しく採番**(team1-1=**1101**,
    team2-1=**1201** = 1000+tn*100+idx)、progress 全ステップ backfill、private_ip 保持。
  - contests に `instance_quota=3` 付与、status=running 保持。team_invites 作成。
  - 部分ユニークインデックス = `WHERE status != 'deleted'`(0003)。孤児 0、2→2 で
    データ欠損なし(fail-fast 不発)。
- → 本番マイグレーションは安全と確認。

## ステップ1: デプロイ + マイグレーション本番適用 ✅

- amd64 クロスビルド → `docker save｜scp｜k3s ctr images import`(import は apphost sudo=
  ユーザー実行)→ `kubectl rollout restart`。
- 新 pod Running、`/api/health` **200**。DB の `effect_sql_migrations` に 1/2/3
  (2・3 は 2026-07-18 08:50 適用)。instances スキーマに vmid/progress/error_message/
  updated_at、contests に instance_quota。既存データ保持(vmid=1101/1201)。孤児 0。

## ステップ2: Phase 3 認証投入 → 実 provisioning 有効化 ✅

- `~/.inucon/portal-env`(CF_*/PROXMOX_* + Phase2 分を保持)+ eevee 証明書 SHA256
  `PROXMOX_TLS_FINGERPRINT`(CN=eevee.tailnet0.ts.net、pod の node TLS で取得)を
  一時ファイル経由で Secret `inucon-portal-env` に投入(値は apphost 上に留め、
  チャット/argv に出さない)。restart 後 pod Running(実ポート+払い出しワーカーの
  Layer 構築成功 = 認証/TLS 有効)。`main.ts` の `ProvisionerConditionalLive` は
  `PROXMOX_API_URL` セットで起動するため**コード変更不要**。
- **Proxmox pre-flight**(pod 内 read-only): `GET /nodes` 200(eevee online)、
  `GET /nodes/eevee/status` 200、空きメモリ 5.27 GiB(RAM ガード閾値 4.66GiB を
  わずかに超過 → 1台は払い出し可、2台目で InsufficientMemory 想定)。

## ステップ3: 実 VM ライフサイクル検証

### テストA: self-service インスタンス追加 → **実機バグ検出**（対応中）

- team1 の Team ページで「インスタンス追加」→ `team1-2`(idx2 想定、vmid 1102,
  IP 10.100.1.12)が **creating → 即 failed**。
- error_message: `{"cause":"Proxmox API GET /api2/json/nodes/eevee/qemu/1102/status/current → 500","_tag":"ProxmoxError"}`
- **根本原因**: 払い出し saga の冪等性チェック `vmExists` は
  `GET .../qemu/<vmid>/status/current` を叩くが、PVE 9 は**存在しない VM に 404 でなく
  500** を返す(実測ボディ
  `{"data":null,"message":"Configuration file 'nodes/eevee/qemu-server/1102.conf' does not exist\n"}`)。
  `requestExistsOrNotFound` が 404 のみ「不在」として吸収し、500 を致命エラーに
  していた。同 404-only 前提の `requestUpidOrNotFound`(teardown の冪等 stop/destroy)も
  同様に、既に消えた VM で 500 → 失敗しうる。
- **対応**: 非 2xx でもボディ message が `does not exist` を含めば「VM 不在」として
  吸収(全 500 を吸収はしない)。両ヘルパーに適用 + テスト。ブランチ
  `phase3/fix-proxmox-vm-notfound`。→ 修正 PR → codex 差分レビュー → マージ →
  再ビルド/再デプロイ → 再検証。

#### 修正1 デプロイ後の再検証 → teardown 側で **第2の不在バグ**

- 修正1(PR #38, `711008e`+`bbcde78`: 同期 500 の VM 設定ファイル欠落を不在扱い)を
  再ビルド・再デプロイ後、まず前回 failed の idx2 を削除(teardown 実機検証)。
- 結果: `deleting → failed`。error_message:
  `task UPID:...qmstop:1102...: failed: exitstatus=unable to find configuration file for VM 1102 on node 'eevee'`
- **根本原因(修正1 とは別経路)**: `POST /qemu/1102/status/stop` は**存在しない VM でも
  200 + UPID(qmstop タスク)を返す**。その非同期タスクが「unable to find configuration
  file for VM 1102」で失敗し、`waitForTask` が致命 ProxmoxError 化。修正1 は同期 500 の
  ボディ判定なので、このタスク exitstatus 経路には効かない(メッセージ表現も別物)。
- **対応(修正2)**: `stopAndDestroyVm` の先頭で `vmExists` チェック → 不在なら冪等スキップ。
  加えて stop/destroy タスクの exitstatus が「unable to find configuration file for VM
  <vmid>」を示す場合も成功扱い(VM 存在確認後に消えるレース対策)。ブランチ
  `phase3/fix-teardown-vm-notfound`。

#### 修正2 デプロイ後の再検証

- 削除リトライ: `failed → deleting → deleted` 完走 ✅(teardown 冪等化の実機確認。
  vmExists 短絡で撤収スキップ)。deleted 行に前回失敗時の error_message が残存する
  表示上の nit あり(状態遷移は正しい。今後の polish 候補)。
- 追加リトライ: `creating → clone_done` まで進んだ後(**クローン実機成功**、VM 1102
  生成)、cloud-init snippet アップロードで failed:
  `Proxmox API POST /api2/json/nodes/eevee/storage/local/upload → 501`
- **失敗時の補償(orphan 防止 saga)が実機で機能**: VM 1102 は自動撤収済み
  (status/current が不在応答)。孤児 VM なし ✅

### 第3の実機バグ: snippet upload の 501/403(2層)

pod からの再現プローブで切り分け:
- undici の整形 multipart(Content-Length 明示)→ **403**
  `Permission check failed (/storage/local, Datastore.AllocateTemplate)`
  = `content=snippets` はパラメータ検証を**通過**(PVE 9.2 の upload API は snippets
  対応)。エラーは権限のみ。
- ポータルの `bodyFormData`(チャンク転送)→ **501**
  = pveproxy のアップロードハンドラは Content-Length 必須(チャンク非対応)。
  ACL 判定より手前の本文処理で 501 になる。
- 経緯: スパイクは `qm` CLI + snippet 手置きで検証しており、**生 API upload 経路は
  実機未検証だった**(スパイクメモに「Task 3 で実装・確認」とあるが確認はスタブのみ)。

**対応(2点)**:
- **A(eevee 権限)**: ロール `InuconPortal` に `Datastore.AllocateTemplate` を追加
  (root 操作、ユーザー実行)。現 privs 15 個 + 1。
- **B(コード)**: `configureCloudInit` の multipart を FormData/チャンクでなく
  手組みボディ(固定 boundary + `Content-Length` 明示、`bodyUint8Array`)に変更。
  ブランチ `phase3/fix-snippet-upload`。

#### 修正3(multipart)+権限追加後の再プローブ → **さらに真因が判明**

- `Datastore.AllocateTemplate` 追加後、Content-Length 明示のプローブは
  `400 Parameter verification failed: content 'snippets' does not have a value in the
  enumeration 'iso, vztmpl, import'`。
- **訂正**: 前節の「content=snippets はパラメータ検証を通過 = snippets 対応」は誤り。
  実際は**権限チェックがパラメータ検証より先**に走っており、403 は検証到達の証拠では
  なかった。**PVE 9.2 の upload API は snippets 非対応**(iso/vztmpl/import のみ)。
  API 経由の snippet 配置は不可能(スパイクの手置き検証を API に置き換えられない)。
- 追加した `Datastore.AllocateTemplate` は不要になったため、後で外してよい
  (クリーンアップ候補)。修正3(multipart 手組み)自体は upload 以外にも正しい
  改善だが、upload 経路ごと廃止する。

### 方針転換: cicustom/snippet → PVE ネイティブ cloud-init パラメータ

- `configureCloudInit` を、snippet アップロード + `cicustom` ではなく
  **`ciuser=isucon` + `sshkeys`(値を percent-encode して送る = PVE の既知仕様)+
  既存の `ipconfig0`/`nameserver`** の単一 `POST /qemu/<vmid>/config` に変更する。
- Ubuntu cloud image の default_user 機構により、`ciuser` のユーザーが NOPASSWD sudo +
  指定鍵で作成される(スパイクの snippet が行っていた内容と同等)。
- アップロード・追加権限とも不要になり、構成がむしろ簡素化される。
  ブランチ `phase3/fix-cloudinit-native`。実機で SSH 可否まで検証し、万一 ユーザー生成
  まわりが image と合わない場合は guest-exec でのユーザー作成+鍵注入(招待経路の
  既存機構の流用)へフォールバックする。

#### 修正4(ネイティブ cloud-init)デプロイ後の再検証 → 大幅前進、第4の実機バグ

- 追加リトライ: `creating → clone_done → configured → started → route_done` まで完走
  ✅(**ネイティブ ciuser+sshkeys の cloud-init 成功、VM 起動成功、CF DNS+ingress 成功**)。
- 最後の Access ステップで failed:
  `Cloudflare API POST .../access/apps/<id>/policies → 400`
- **根本原因(実 DB で確認)**: team1 の唯一のメンバー kisepichu は `users.email` が
  null(email は招待フローで登録される設計。Phase 2 の割当のみのため未登録)。
  `ensureAccessApp` が `include: []`(空)のポリシーを POST し、CF が 400 を返す。
- 失敗時の補償は今回も機能(VM/route/app 掃除)。
- **対応(修正5)**: include が空になる場合はポリシー書き込みをスキップする
  (ポリシー無し = Access は deny-by-default で安全側。email は後から招待フローが
  登録し、その時の `ensureAccessApp` 再実行でポリシーが作られる)。新規アプリ作成時
  ポリシー POST・allow ポリシー不在時 POST・和集合 PUT の 3 経路すべてにガード。
  ブランチ `phase3/fix-access-empty-emails`。

#### 修正5 デプロイ後の再検証 → **テストA 完走 ✅**

- 旧 failed 削除(→deleted)後、追加を実行。**約20秒でフル払い出し成功**:
  `creating → clone_done → configured → started → route_done → access_done → running`
  (13:27:27 → 13:27:47)。
- eevee 実機確認: VM 1102 running(name=inucon-team1-2)、`ciuser=isucon`、
  `ipconfig0=gw=10.100.1.1,ip=10.100.1.12/24`、`net0 bridge=team1`(チーム VNet 分離)、
  sshkeys 設定済み。Access アプリは作成済み・ポリシーは email 登録待ち(意図どおり)。
- eevee 空きメモリ 3.25GiB(閾値 4.66GiB 未満)→ 次の追加は InsufficientMemory になる
  見込み(RAM ガードの自然なテストに使える)。

### テストC: 招待3点セット + Access 拒否 + SSH ✅(すべて実機確認)

1. **Access deny-by-default(= Phase 1 開催前 TODO の消化)**: email 登録前に
   `ssh isucon@inucon-team1-2.kisen.one` → CF Access の認証画面に飛び、未許可メールを
   入れると「メールを送りました」表示になるが**実際には認証メールが届かない**ことを確認。
   ポリシー無しアプリの拒否挙動として期待どおり。
2. **招待実行**(Admin → 招待、team1 / kisepichu / Access 用メール):
   結果カード = ポータル: 即時割当(既にログイン済み)/ Access: OK /
   sshKeys: 9d88324c(idx1=1101)OK・f77dbc8b(idx2=1102)OK。
3. **SSH 開通**: 招待後 `ssh isucon@inucon-team1-2.kisen.one` 成功
   (Access 認証 → benchvm tunnel route → 新 VM、cloud-init 鍵 + guest-exec 鍵)。

### テストB: ベンチ + ガード類 ✅

- **ベンチ実行**: inucon-team1-2(10.100.1.12)を対象に enqueue → runner(benchvm)が
  実行 → finished + スコア表示 → **Scoreboard 反映確認**。
- **InstanceInUse(#D 原子ガードの実機確認)**: ジョブ実行中に対象インスタンスの削除を
  押すと「ベンチ対象中は削除できません」✅。
- **quota ガード**: 3台目の払い出し後(active 3 = quota 3)、追加ボタンが **UI 側で
  disabled** になり押せないことを確認 ✅(サーバー側 QuotaExceeded/原子的
  createIfAllowed はテストでカバー済み)。
- **RAM ガードの実機挙動**: 2台目起動直後は free 3.25GiB(< 閾値 4.66GiB)だったが、
  3台目の追加は成功した。原因は **KSM**(クローン VM 同士の同一ページ統合。
  ksm shared 3.53GiB を実測)で、クリック時点の実測 free が閾値以上に回復していた
  ため。ガードは実値を読んで正しく判定しており、バグではない(admission 時の
  fail-fast ヒューリスティックという設計どおり)。3台目も約20秒で running 完走。

### テストD: 実 VM の削除(本物 teardown)✅

- team1-3 → team1-2 を順に削除(チーム進行中1本ガードにより直列)。両方 deleted 完走。
- 事後総点検: DB non-deleted は idx1(terraform)のみ / eevee の VM 1102・1103 消滅 /
  空きメモリ 7.49GiB に回復 / CF DNS 0 件 / Access アプリ 0 件 / tunnel ingress は
  terraform 分(team1-1, team2-1)+ catch-all のみ。**孤児リソースなし**。

## Task 7 結果まとめ

- デプロイ(amd64 クロスビルド → ctr import → rollout)+ migration 0002/0003 本番適用 ✅
- 実機でしか出ない4つのバグを検出・修正(すべて PR + codex 差分レビュー + マージ):
  1. PR #38: 存在しない VM への status/current が 404 でなく 500(does not exist)
  2. PR #39: qmstop タスクの不在 exitstatus(teardown 冪等化 + vmExists 短絡)
  3. PR #40→#41: snippet の API upload は PVE 9 で不可(→ ネイティブ ciuser+sshkeys へ転換)
  4. PR #42: email 未登録チームの空 include ポリシーが CF 400(スキップ + deny-by-default)
- フルライフサイクル実証: 追加(~20秒で running)→ SSH(Access 認証込み)→ ベンチ →
  Scoreboard → 削除(完全掃除)。招待3点セット、Access 拒否(Phase 1 TODO)、
  InstanceInUse、quota、削除直列化も実機確認。
- 失敗時の補償(孤児 VM 防止 saga)は全失敗ケースで正しく機能した。

### 残タスク / クリーンアップ

- eevee ロール `InuconPortal` の `Datastore.AllocateTemplate` は不要になったため除去してよい
  (upload 経路は廃止済み)。
- UI polish 候補(軽微): deleted 行が一覧に残り、過去の error_message を表示し続ける。
- コンテスト未 running 時のインスタンスアクセス遮断は別タスク(既記録)。
- benchvm runner env の agenix 化(既存 TODO)。
