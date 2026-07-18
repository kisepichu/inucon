# INUCON Phase 3(セルフサービス + 招待自動化)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** チームメンバーがポータルから競技 VM を追加/削除でき、admin が 1 操作でメンバー招待(チーム割当 + Access + SSH 鍵)を完了できるようにする。

**Architecture:** Phase 2 の軽量ヘキサゴナル 3 層(domain 純粋 / application = ユースケース + port / infrastructure = adapter Layer)を踏襲。新 port(Proxmox / Cloudflare / GithubKeys)を追加し、払い出し/撤収は DB に進行状態を持つ常駐ワーカー(Phase 2 の TimeoutSweeper と同型)が saga で実行する。スペック: `docs/superpowers/specs/2026-07-10-phase3-selfservice-design.md`(必読)。

**Tech Stack:** Phase 2 と同一(effect 3.21.x + @effect/platform + @effect/sql-sqlite-node + @effect/vitest、React + Vite)。

## Global Constraints

- Phase 2 の Global Constraints(層の依存規則、旧 API 禁止、Config.redacted、コミットは `/commit`、タスクごとに develop からブランチ → PR → `/pr-review` → マージ)をすべて継承する
- domain(`portal/src/domain/`)は effect の Schema / Either / Option / Data / Match のみ。application は domain・自層 port・effect コアのみ、infrastructure を import しない。Layer 合成は `portal/src/main.ts`
- **本番 DB が存在する**(apphost の PVC)。migration は前方専用(0002 を新規追加。既存 0001 は書き換えない)。既存 `active` 行の `running` への移行を 0002 に含める
- **外部副作用の port はすべて冪等**(ensure/remove 系、stopAndDestroy は無ければ成功)。saga は進行状態(instances.progress)を DB に記録し、プロセス再起動・リトライ・再実行で孤児/二重作成を作らない
- **guestExec に渡すコマンドはコード内固定**(authorized_keys 追記のみ)。可変部は SSH 公開鍵文字列のみで、authorized_keys 形式(`<keytype> <base64> [comment]`)を検証してから argv 分離(シェル展開に渡さない)。keytype は許可リスト、keydata は base64 のみ: `^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) +[A-Za-z0-9+/]+=* *(\S.*)?$`(keytype と keydata の間は 1 個以上の空白必須、改行・制御文字を含む鍵は弾く)
- **Access ポリシー更新は現行 include との和集合 PUT**(締め出し防止。スペック §招待フロー)
- VM スペックは固定 2vCPU/4GB/20GB(ユーザー入力を受けない)。vmid = `1000 + teamNumber*100 + index`、IP = `10.100.<teamNumber>.1<index>`
- 秘密情報(Proxmox / Cloudflare トークン)は Config.redacted + k8s Secret。リポジトリ・チャット・ログに出さない
- リモート操作(eevee/apphost/benchvm への SSH、kubectl、Cloudflare/Proxmox の破壊的 API)で資格情報や承認が不足する場合は BLOCKED として報告し、勝手に回避しない

## ファイル構造(Phase 2 からの追加)

```
portal/src/
  domain/          instance.ts(状態機械へ拡張), errors.ts(追加)
  application/
    ports.ts       ProxmoxPort / CloudflarePort / GithubKeysPort 追加
    usecases/      instances.ts(拡張: 追加/削除), invites.ts(新規), provisioning.ts(saga)
  infrastructure/
    sql/migrations/0002_selfservice.ts, repos/{instanceRepo,inviteRepo,contestRepo}.ts(拡張/新規)
    proxmox/client.ts   ProxmoxPort Live
    cloudflare/client.ts CloudflarePort Live
    github/keys.ts      GithubKeysPort Live
    http/handlers/{instances,admin}.ts(拡張)
    worker/provisioner.ts  払い出し/撤収ワーカー Layer
  web/src/pages/{Team,Admin}.tsx(拡張)
docs/superpowers/research/2026-07-11-phase3-spike.md  Task 1 の spike 結果
```

---

### Task 1: Spike + 前提インフラ(実測でスペックの未確認事項を潰す)

**目的:** コードを書く前に、スペックのリスク 1〜5 を実機で確定する。**このタスクの成果物は調査メモとインフラ設定であり、portal のコードは書かない。**

**リモート作業を含むため、資格情報不足時は BLOCKED 報告。**

- [ ] **Step 1: linked clone + 標準 cloud-init の検証(リスク 1)。** eevee で `tpl-private-isu`(9100)から検証用 VM(team1 の index 9 相当 = vmid `vmidFor(1,9)` = 1109、IP `ipFor(1,9)` = 10.100.1.19)へ linked clone し、`qm set 1109 --ipconfig0 ip=10.100.1.19/24,gw=10.100.1.1 --sshkeys <file> --net0 ...`(チーム1 VNet bridge)→ `qm start` → guest agent 経由で IP と authorized_keys が入るか確認。**入らなければ代替(guestExec で IP/鍵注入、cloud-init 非依存)を検証**。検証後 clone は破棄。結果(どの方式が動くか、必要な qm 引数の正確形)を `docs/superpowers/research/2026-07-11-phase3-spike.md` に記録
- [ ] **Step 2: Proxmox API トークンの最小権限(リスク 2)。** eevee で portal 用トークンを作り、clone / config / start / stop / destroy / guest-exec / status に必要な privilege を実測で確定(足りなければ足す)。トークン値は記録せず apphost の k8s Secret へ入れる手順を spike メモに記載(値は Secret にのみ、リポジトリに書かない)
- [ ] **Step 3: guest agent exec の挙動(リスク 3)。** `agent/exec` + `agent/exec-status` で isucon ユーザーの authorized_keys に追記できるか、出力サイズ/タイムアウトを実測。API の正確なエンドポイント形と応答をメモ
- [ ] **Step 4: RAM ガードの閾値(リスク 4)。** `nodes/eevee/status` の memory と ARC の関係を実測し、「空き」の定義と作成拒否の閾値(例: 4GB VM を作る前に free ≥ 5GB)を決めてメモ
- [ ] **Step 5: Access アプリ数上限(リスク 5)** を Cloudflare ドキュメント/API で確認しメモ
- [x] **Step 6: benchvm トンネル(0000aaaa)の remotely managed 化。** cloudflared を **token 方式**(`cloudflared tunnel run --token <TOKEN>`。env `TUNNEL_TOKEN` を渡せば `--token` フラグは省略可・等価)で起動する systemd サービスに置き換え、ingress を CF API の tunnel configurations で管理する。**重要**: `--config <file>` 方式(NixOS の services.cloudflared モジュール = credentials.json 起動)はローカル ingress を使い remote を無視するため使えない(spike で実測)。apphost は locally managed のままで方式が異なる(統一しない)。**既存の SSH 経路に影響するため、切り替え後に `ssh inucon-team1-1.kisen.one` が通ることを確認してからマージ**。→ **spike(Task 1)で実施済み**(nixos-config-private #9)
- [ ] **Step 7: spike の結論をスペックに反映**(採用方式でリスク欄を「解決済み」に更新する追記 PR。または本計画の後続タスクの記述を確定値へ更新)
- [ ] **Step 8: /commit(spike メモ)→ /pr → /pr-review → マージ**(nixos PR も)

---

### Task 2: domain(Instance 状態機械)+ migration 0002

**Files:**
- Modify: `portal/src/domain/instance.ts`(状態機械化)、`portal/src/domain/errors.ts`(追加)
- Create: `portal/src/infrastructure/sql/migrations/0002_selfservice.ts`
- Test: `portal/test/domain/instance.test.ts`、`portal/test/infrastructure/migration0002.test.ts`

**Interfaces(後続が依存。名前・型はここが正):**

```ts
// instance.ts
export type InstanceStatus = "creating" | "running" | "deleting" | "deleted" | "failed"
export type ProvisionStep = "clone_done" | "configured" | "started" | "route_done" | "access_done"
export class Instance extends Schema.Class<Instance>("Instance")({
  id: InstanceId, teamId: TeamId,
  index: Schema.Int.pipe(Schema.positive()),
  vmid: Schema.Int, privateIp: Schema.String,
  status: Schema.Literal("creating", "running", "deleting", "deleted", "failed"),
  progress: Schema.Array(Schema.Literal("clone_done", "configured", "started", "route_done", "access_done")),
  errorMessage: Schema.OptionFromNullOr(Schema.String),
  createdAt: Schema.Int, updatedAt: Schema.Int
}) {}
// 純粋遷移関数(Either)。now は epoch ms
export const newInstance: (args: { id: InstanceId; teamId: TeamId; index: number; teamNumber: number; now: number }) => Instance  // status creating, vmid/ip 計算
export const markProvisioned: (i: Instance, now: number) => Either<Instance, InvalidInstanceTransition>  // creating→running(progress 全部済み前提)
export const beginDeleting: (i: Instance, now: number) => Either<Instance, InvalidInstanceTransition>    // running/failed→deleting
export const markDeleted: (i: Instance, now: number) => Either<Instance, InvalidInstanceTransition>      // deleting→deleted
export const markFailed: (i: Instance, message: string, now: number) => Instance                          // creating/deleting→failed
export const addStep: (i: Instance, step: ProvisionStep, now: number) => Instance                         // progress へ追加(冪等)
export const vmidFor: (teamNumber: number, index: number) => number   // 1000 + tn*100 + idx
export const ipFor: (teamNumber: number, index: number) => string     // 10.100.tn.1{idx}
```

- [ ] Step 1: 失敗テスト。遷移の成否網羅、vmidFor(1,1)===1101 / ipFor(1,1)==="10.100.1.11"、addStep 冪等、不正遷移が left
- [ ] Step 2: 失敗確認 → 実装
- [ ] Step 3: migration 0002 テスト。`:memory:` に 0001→0002 を適用し、instances に vmid/error_message/progress/updated_at・contests に instance_quota(既定3)・users に email・team_invites テーブルができ、status CHECK が新集合、既存 `active` 行が `running` に移ること(0001 で active 行を入れてから 0002 を適用するテスト)。UNIQUE(team_id, idx) が部分インデックス(status IN creating/running/deleting)になり、deleted 行があっても同 idx を作れること
- [ ] Step 4: 全緑 + typecheck
- [ ] Step 5: /commit → /pr → /pr-review → マージ

---

### Task 3: port 3 種(Proxmox / Cloudflare / GithubKeys)の契約 + Live + テスト

**Files:**
- Modify: `portal/src/application/ports.ts`(3 port + エラー型追加)
- Create: `portal/src/infrastructure/proxmox/client.ts`, `portal/src/infrastructure/cloudflare/client.ts`, `portal/src/infrastructure/github/keys.ts`
- Test: `portal/test/infrastructure/{proxmox,cloudflare,githubKeys}.test.ts`(HTTP スタブ)+ インメモリ port(`portal/test/support/inMemory.ts` 拡張)

**Interfaces:** スペック §アーキテクチャの 3 port(Effect.Effect 表記)をそのまま。エラー型 `ProxmoxError` / `CloudflareError` / `GithubKeysError` / `ProvisionTimeout` は `Data.TaggedError`(RepoError と同じ置き場: ports.ts)。

**実装の要点(Task 1 spike の確定値を使う):**
- Proxmox Live: HttpClient + トークンヘッダ(`Authorization: PVEAPIToken=<id>=<secret>`)。**TLS は検証スキップを既定にしない** — eevee 証明書/CA を信頼ストアに追加(検証有効)か、フィンガープリントのピン留め(`PROXMOX_TLS_FINGERPRINT` を env で渡し一致確認)を採用する(spike メモの方針参照)。`cloneVm` は clone タスクの UPID を `tasklog`/`status` でポーリングして完了待ち。`guestExec` は exec → exec-status ポーリング
- Cloudflare Live: Phase 1-2 の runbook の API を関数化。`ensureAccessApp` は GET → 和集合 → PUT。`ensureInstanceRoute` は DNS CNAME upsert + tunnel configurations の ingress 追加(catch-all の前に挿入、全置換なので既存保持)
- GithubKeys Live: `GET https://github.com/<login>.keys`、空なら GithubKeysError、各行を公開鍵形式で検証

- [ ] Step 1: 各 port の HTTP スタブテスト(正常系 + エラー系。Cloudflare は「和集合になる」「catch-all を消さない」を検証)
- [ ] Step 2: 失敗確認 → 実装(Live)。インメモリ実装も追加
- [ ] Step 3: 全緑 + typecheck
- [ ] Step 4: /commit → /pr → /pr-review → マージ

---

### Task 4: 払い出し/撤収オーケストレーション(ワーカー + saga + ガード)

**Files:**
- Create: `portal/src/application/usecases/provisioning.ts`(saga 本体)、`portal/src/infrastructure/worker/provisioner.ts`(常駐 Layer)
- Modify: `portal/src/application/usecases/instances.ts`(追加/削除ユースケース)、`portal/src/application/ports.ts`(InstanceRepo に状態遷移メソッド追加)、`portal/src/main.ts`(ワーカー merge)
- Test: `portal/test/application/provisioning.test.ts`、`portal/test/worker/provisioner.test.ts`(TestClock + インメモリ port)

**要点:**
- `requestCreateInstance`(ユースケース): トランザクション内で quota 再検証(creating+running ≤ instanceQuota)+ 進行中 1 本(チームに creating/deleting が無い)+ RAM ガード → creating 行 INSERT(insertIfAllowed と同パターン)。202 相当で即応答
- `requestDeleteInstance`: running のみ、対象 IP を持つ BenchJob が queued/running なら 409、deleting へ
- ワーカー(`Layer.scopedDiscard` + `Effect.repeat(Schedule.spaced("2 seconds"))` + `catchAllCause(logError)`、Phase 2 の生存性優先思想): creating/deleting 行を 1 件拾い、progress を見て未完ステップから再開。
  - 払い出し: clone → configure → start → waitForGuestAgent →(cloud-init 非依存方式なら guestExec で IP/鍵)→ ensureInstanceRoute → ensureAccessApp、各ステップ後に addStep 保存 → 全部済みで markProvisioned
  - 撤収: removeAccessApp → removeInstanceRoute → stopAndDestroyVm → markDeleted(全冪等)
  - 失敗: 払い出しは progress の逆順に補償(作った経路/VM を消す)→ markFailed。撤収失敗は markFailed(手動介入)
- **同時実行制御**: ワーカーは全体で 1 度に 1 インスタンスのオーケストレーションのみ進める(clone/RAM の競合回避。BenchJob の全体 1 本と同型)

- [ ] Step 1: 失敗テスト。ガード各分岐(quota 超過 / 進行中あり / RAM 不足 / ベンチ中削除)、saga 正常系(payload の呼び出し順)、途中失敗時の補償(作ったものだけ消す)、再開(progress 途中の行を拾って残りを実行)、撤収冪等
- [ ] Step 2: 失敗確認 → 実装
- [ ] Step 3: 全緑 + typecheck
- [ ] Step 4: /commit → /pr → /pr-review → マージ

---

### Task 5: 招待自動化(invites API + 初ログイン自動所属 + Access/鍵注入)

**Files:**
- Create: `portal/src/application/usecases/invites.ts`、`portal/src/infrastructure/sql/repos/inviteRepo.ts`、`portal/src/infrastructure/http/handlers/admin.ts`(既存を拡張、invites エンドポイント追加)
- Modify: `portal/src/application/usecases/auth.ts`(初ログイン時に team_invites を消費して所属 + email 引き継ぎ)、`shared/src/api.ts`、`portal/src/main.ts`
- Test: `portal/test/application/invites.test.ts`、`portal/test/http/invites.test.ts`

**要点(スペック §招待フロー):**
- `POST /api/admin/teams/:id/invites { githubLogin, email }`: users にいれば即所属 + email 更新、いなければ team_invites 作成。そのチームの全 running インスタンスの Access アプリを和集合更新 + guestExec で鍵追記。結果は `{ portal, access, sshKeys[], warnings[] }`(email 未登録メンバーは warnings)。全ステップ冪等
- 初ログイン(auth.ts): handleOAuthCallback で upsert 後、team_invites に一致行があれば team_members へ INSERT + users.email に invite の email をセット + invite 行削除
- 新規インスタンス作成時(Task 4 のワーカー)は「メンバー + 招待中」のメール/鍵で Access/authorized_keys を構成 — invites.ts の共通関数を provisioning から呼ぶ

- [ ] Step 1: 失敗テスト。未ログイン招待→team_invites 作成→(スタブ OAuth で)初ログイン→自動所属 + email 引き継ぎ + invite 消費。既ログイン招待→即所属。Access 和集合更新の呼び出し、鍵注入の呼び出し、email 未登録の warning、再実行の冪等
- [ ] Step 2: 失敗確認 → 実装
- [ ] Step 3: 全緑 + typecheck
- [ ] Step 4: /commit → /pr → /pr-review → マージ

---

### Task 6: UI(追加/削除ボタン・状態表示・招待フォーム)

**Files:** Modify `portal/web/src/pages/{Team,Admin}.tsx`、`portal/web/src/api.ts`

- Team: インスタンス追加ボタン(quota 到達/進行中は無効化 + 理由)、各行に状態バッジ(creating/deleting はスピナー + 5 秒ポーリング)、削除ボタン(確認ダイアログ、ベンチ中は 409 をエラー表示)
- Admin: 招待フォーム(githubLogin + email)、招待中一覧、招待結果(3 点の成否 + warnings)表示
- ポーリングは既存パターン(cleanup 済み)。エラーは既存の error 表示に載せる

- [ ] Step 1: 実装(`pnpm --filter web build` + typecheck 通過)
- [ ] Step 2: ローカルで手動確認(スタブ OAuth で admin ログイン → 招待フォーム描画、Team のボタン活性/非活性)、スクショを PR に
- [ ] Step 3: /commit → /pr → /pr-review → マージ

---

### Task 7: 本番検証(実 VM で一連 + 招待 3 点セット)

**Files:** `docs/superpowers/specs/2026-07-10-phase3-selfservice-design.md`(完了注記)、`deploy/README.md`(運用追記)

- [ ] Step 1: 新イメージをビルド → apphost へインポート(deploy/README.md の方式)→ rollout。migration 0002 が本番 DB に適用され既存 active 行が running になること・既存 2 台(team1-1/team2-1)が台帳に整合していることを確認(必要なら admin の台帳取り込み経路で vmid を登録)
- [ ] Step 2: Team ページから team1 にインスタンス追加 → creating→running を UI で確認 → `ssh inucon-team1-2.kisen.one` で入れること → そのインスタンスにベンチ → スコア → 削除 → deleted、を実測
- [ ] Step 3: quota 到達で追加ボタンが塞がる・ベンチ実行中の削除が 409、を実測
- [ ] Step 4: 招待の実測(**Phase 1 からの TODO「Access 許可外拒否の実測」もここで消化**): 別 GitHub アカウント + メールで招待 → そのアカウントで Access 認証 → SSH 成功、招待していないアカウントは Access で拒否、を実測
- [ ] Step 5: 結果をスペック完了注記に記録。Phase 3 完了を親スペックのフェーズ計画に記録
- [ ] Step 6: /commit → /pr → /pr-review → マージ

---

## Self-Review(執筆時に実施済み)

- スペック各節とタスク対応: 状態機械/DB→Task 2、port→Task 3、払い出し/撤収+ガード→Task 4、招待→Task 5、UI→Task 6、前提インフラ+spike→Task 1、本番検証(マイルストーン7)→Task 7。取りこぼしなし
- 型整合: Instance/ProvisionStep/port シグネチャは Task 2/3 で定義し後続が参照。再定義なし
- 未確認点はすべて Task 1 の spike に集約し、後続タスクは spike の確定値を使う前提を明記
- 破壊的リモート操作(clone/destroy/トークン/トンネル切替)は Task 1/7 に隔離し BLOCKED 報告の方針を Global Constraints に記載
