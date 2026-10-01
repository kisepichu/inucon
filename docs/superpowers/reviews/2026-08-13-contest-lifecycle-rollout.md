# Contest lifecycle automation rollout evidence

**Plan:** `docs/superpowers/plans/2026-08-13-contest-lifecycle-automation.md`
Task 15 (Recovery runbooks, full verification, reviewed rollout, and first
reconciliation)。本 report は Task 15 Step 12 の deliverable。

**Scope:** 実装フェーズ (Task 1-13) + agenix source of truth (Task 14) +
runbook / verification (Task 15 Step 1-3) の完了、および人手フェーズ (Task
15 Step 4-11) の rollout evidence を残す。

**状態 (2026-10-01):** Step 6 (merge / image import / manifest apply)、
Step 7 (benchvm 起動 / agenix 切替 / 旧 token revoke)、Step 8 (突合 +
archive Operation + off-host verified 化)、Step 9 (reconciliation
apply)、Step 10 (cleanup + 再監査) が完了し、readiness
`previous_cleanup` が pass した。**Step 4 / Step 5 は実施できなかった**
(§B-1 / §B-2 — 値を埋めず「実施せず」として確定)。Step 11 (edition2
draft) は実開催日程が決まるまで未実施。未実施項目には実行コマンドと期待
結果を書いてあり、`TBD: <human>` は**人手でまだ実施していない値にのみ**
残す。

**値の扱い:** 本 report の実測値は 2026-09-22 / 09-23 / 10-01 に実機
(apphost `192.0.2.20` / eevee `192.0.2.10` / 公開 API
`http://192.0.2.20:30080`) から取得したもので、各節に再導出コマンドを
併記した。再導出して値が変わったら、変わったこと自体を追記する。

**Secret handling:** この report に token / API key / Cloudflare secret /
Access 許可 email / SSH 鍵 / Authorization header / OAuth secret / age
平文を絶対に書き込まない。値はすべて
`../nixos-config-private/secrets/*.age` (agenix) 側で管理する。
hostname / VMID / commit hash / SHA-256 / LAN IP / MAC / **Secret の
キー名**は記載可。commit 前に本ファイルを走査すること:

```sh
grep -inE 'ghp_|github_pat_|PVEAPIToken=|Bearer |BEGIN [A-Z ]*PRIVATE KEY|@gmail|@users\.noreply|AGE-SECRET-KEY' \
  docs/superpowers/reviews/2026-08-13-contest-lifecycle-rollout.md
```

`AGE-SECRET-KEY` は age 秘密鍵 (`AGE-SECRET-KEY-1...`) のプレフィックス。
上の禁止事項に age 平文を挙げている以上、走査コマンド側にも必ず含める
(このパターンが漏れていたのを PR #72 review round 3 で指摘され追加した)。
唯一の想定ヒットはこの走査コマンド自身の行なので、
`grep -v` で除くか行番号で確認する。

## 前提

- Task 14 実施状態 (2026-08-18 実施、2026-09-23 に実機再確認):
  - Proxmox pool: `inucon-team-vms` (comment `INUCON team VMs (Task14)`、
    member は `vmid 9100` のみ)。
  - users: `inucon-provision@pve`, `inucon-mode@pve` (password なし)。
  - tokens: 両 user に `portal-2026-08-18a` (`privsep=0`) を 1 本ずつ。
    旧 `portal@pve!inucon` は Step 7 の smoke 完了確認まで温存 —
    **2026-09-23 時点で未 revoke** (Section C 参照)。
  - custom role: `InuconMode` = `VM.Audit,VM.Config.Options,VM.PowerMgmt`
    / `InuconNodeAudit` = `Sys.Audit` / `InuconProvisionVm` =
    `VM.Allocate,VM.Audit,VM.Clone,VM.Config.Cloudinit,VM.Config.Disk,`
    `VM.Config.Network,VM.Config.Options,VM.GuestAgent.Audit,`
    `VM.GuestAgent.Unrestricted,VM.PowerMgmt`。
  - storage: **`local-zfs`** (plan 本文の `local-lvm` は誤記、Task 15
    で修正済み。commit `0a009d7` = PR #68 squash merge)。実機 ACL も
    `PVEDatastoreUser on /storage/local-zfs` で一致。

  再導出:
  ```sh
  ssh root@192.0.2.10 'pveum pool list; pveum acl list; pveum role list'
  ```

- sub-agent 担当 (Task 15 Step 1-3, 12):
  - runbook: `docs/runbooks/contest-recovery.md` 新規作成、
    `docs/runbooks/contest-operations.md` / `deploy/README.md` /
    `README.md` を更新。
  - verification: `pnpm -r typecheck && pnpm -r test && pnpm -r build &&
    docker build -f deploy/Dockerfile -t inucon-portal:contest-automation .`
    をローカル (WSL) で完全実行。
  - PR: `feat/contest-rollout-docs` → develop、`/pr-review claude` で
    review 対応 (最大 3 round、cap / findings-none で終了、4 round 目は
    high/critical のみ、残りは follow-up)。

- 人手担当 (Task 15 Step 4-11):
  - apphost / benchvm 上で `sudo nixos-rebuild switch`。
  - 旧 `/home/kise/.inucon/runner-env` 等の平文 EnvironmentFile 削除。
  - 旧 `portal@pve!inucon` (統合 token) の
    `pveum user token remove` による revoke。
  - WSL 上での pre-migration snapshot 作成、dry-run migration 突合。
  - develop → main / `nixos-config-private` 側の merge、image build /
    import、初回 rollout / cleanup / edition2 draft 作成。

---

## Section A: sub-agent 担当 (Task 15 Step 1-3)

### A-1. Runbook 差分

- 新規: `docs/runbooks/contest-recovery.md`
  (12 節 + 用語 + Task 15 人手工程の明記。stale plan / ambiguous CF
  policy / duplicate DNS / missing VM / shutdown timeout / insufficient
  RAM / stale runner / backup unavailable / failed cleanup / migration
  rollback / credential rotation / finalizing で stuck を全カバー。)
- 更新: `docs/runbooks/contest-operations.md` (第 n 回開催手順を Admin
  Web 前提に書き換え、旧 SQL 直叩き手順を撤去、recovery runbook への
  誘導を追加)。
- 更新: `deploy/README.md` (agenix source of truth と recovery runbook
  への誘導を冒頭に追加)。
- 更新: `README.md` (主要ドキュメントに recovery runbook を追加)。

commit: `0a009d7` (`docs(contest): recovery runbook + rollout evidence
template (Task 15 sub-agent scope) (#68)`、2026-08-18)。PR #68 は squash
merge なので runbook / rollout template / plan storage typo fix
(`local-lvm` → `local-zfs`) の 3 点すべてがこの 1 commit に入っている。

再導出:
```sh
git log --oneline -S 'local-zfs' -- \
  docs/superpowers/plans/2026-08-13-contest-lifecycle-automation.md
```

### A-2. 完全 verification

環境: WSL 2 (Linux 6.18.33.2-microsoft-standard-WSL2、AMD Ryzen 5 3600X)、
Node 22 系、pnpm、Docker Desktop。

コマンド (Task 15 Step 2 の指定通り、順不同ではなく `&&` チェーン):

```sh
pnpm -r typecheck \
  && pnpm -r test \
  && pnpm -r build \
  && docker build -f deploy/Dockerfile -t inucon-portal:contest-automation .
```

結果 (sub-agent 実測、2026-08-18T02:12Z 前後、WSL2 上):

| Step | 結果 | 実測 |
| --- | --- | --- |
| `pnpm -r typecheck` | pass | exit code 0 (shared / portal / portal-web / runner) |
| `pnpm -r test` | pass | portal 706 pass + 2 skipped / 51 files、portal/web 33 pass / 3 files、runner 14 pass / 2 files、fail 0 |
| `pnpm -r build` | pass | exit code 0 (shared → web → portal + runner)、web bundle `dist/assets/index-*.js` 290.25 kB (gzip 87.56 kB) |
| `docker build -f deploy/Dockerfile -t inucon-portal:contest-automation .` | pass | image `sha256:315b5a7374eeb74f1146edc4ca9eb2e97c29d015a3f481898e14107a6c9d7d70`、tag `inucon-portal:contest-automation` (local only、`--push`/`--load` は使っていない) |

verification 実施ホスト: WSL2 (Linux 6.18.33.2-microsoft-standard-WSL2、
AMD Ryzen 5 3600X)。実行時刻 (UTC): 2026-08-18T02:11Z 〜 2026-08-18T02:14Z。

> 人手側で production build を再実行するときは、同じ 4 コマンドを走らせて
> counts / digest を突合する。数値が変わったら plan の Final Verification
> Matrix と本 report の両方を更新する。

### A-3. PR / review

- PR: <https://github.com/kisepichu/inucon/pull/68>
  (`feat/contest-rollout-docs` → `develop`、state `MERGED`、
  merge commit `0a009d7267e55d87e7648f4b20801adab23b8707`、
  merged at 2026-08-18T02:53:52Z)
- review workflow: `/pr-review claude` — 3 round すべて発火し、
  round ごとに findings → 修正 commit → 再トリガを回した。

  | round | trigger (UTC) | claude 応答 (UTC) | findings | 対応 commit |
  | --- | --- | --- | --- | --- |
  | 1 | 2026-08-18T02:16:40Z | 2026-08-18T02:22:14Z | 2 (correctness + accuracy) | `b22b89d` |
  | 2 | 2026-08-18T02:25:30Z | 2026-08-18T02:34:21Z | 2 (correctness + data residue) | `3b1dab9` |
  | 3 | 2026-08-18T02:36:34Z | 2026-08-18T02:50:19Z | 2 (accuracy + input validation) | `fed1171` |

  - round 1: (a) §10 migration rollback の WAL/SHM 削除が
    `kubectl run --rm` で既に消えた pod を `exec` しようとしていた
    (WAL replay が restore を巻き戻す) → busybox の command に畳んだ。
    (b) §12 の cancel SQL が `OperationRepo.cancel` の
    `operation_steps` UPDATE を欠いており「等価」表記が不正確だった。
  - round 2: (a) §12 の 2 つの UPDATE が非結合で、
    `blocked` → `running` への race で operations UPDATE が 0 行でも
    steps UPDATE が走る TOCTOU → `AND (SELECT status FROM operations
    WHERE id='$OP') = 'canceled'` の subquery guard を追加。
    (b) §10 の `rm /tmp/portal-restore.db` が `&&` 依存で、
    `kubectl run` 失敗時に全開催回分の生 DB が apphost `/tmp` に残る →
    `trap ... EXIT` に変更。
  - round 3: (a) §5 の「scheduler が `enter_contest_mode` を再 enqueue
    する」が誤り (`contestScheduler.ts` は `tickFinalize` /
    `tickRevokeAccess` / `tickCleanup` のみ) → operator が Admin Web から
    再リクエストする手順に訂正。(b) §12 の `$OP` が shell 展開で SQL に
    直挿入されるため UUID v4 regex による事前 abort を追加。
  - 4 round 目には達していない (round cap = 3 で `fed1171` 時点で
    ループを閉じた)。follow-up コメント URL は発生せず。
  - max-turns 失敗による `@claude review` 再トリガ: **なし**。3 round
    すべて 1 回のトリガで完走した。
- **inline comment は 1 件も投稿されていない** (実測:
  `gh api repos/kisepichu/inucon/pulls/68/comments` = 0 件)。findings は
  すべて top-level issue comment として届いた。sentinel 文字列が
  `CLAUDE_REVIEW: 2 issue(s) -- see inline comments` と inline を名乗る
  ため紛らわしいが、実体は summary comment である。§C-2 参照。
- develop merge commit: `0a009d7`
- release notes / changelog に相当する Contest 変更点: このリポジトリは
  changelog を持たないため PR description に集約。

再導出:
```sh
gh pr view 68 -R kisepichu/inucon --json url,state,mergeCommit,mergedAt
gh pr view 68 -R kisepichu/inucon --json comments \
  --jq '.comments[] | "[\(.createdAt)] \(.author.login)"'
gh api repos/kisepichu/inucon/pulls/68/comments --jq 'length'
```

---

## Section B: 人手担当 (Task 15 Step 4-11)

実施日: **2026-09-22 〜 2026-09-23**、および **2026-10-01** (Step 8 archive と
readiness 修正)。plan 策定は 2026-08-13、Task 14 は 2026-08-18。以下は human
operator が実施した結果の記録。

**plan からの逸脱・rollout 中に発覚した欠陥のサマリ:**

| # | 種別 | 内容 | 記録先 |
| --- | --- | --- | --- |
| 1 | 逸脱 (重大) | Step 4 の pre-migration snapshot を**取得できなかった** | §B-1 |
| 2 | 逸脱 (重大) | Step 5 の dry-run migration を**実施できなかった** | §B-2 |
| 3 | 欠陥 (未発火) | `modeVmIds.ts` の devvm/benchvm VMID が実機と逆 | §B-9 |
| 4 | 障害 (復旧済) | `inucon.kisen.one` が 35 日間 502 | §B-10 |
| 5 | 前提崩れ | apphost の LAN IP が `.156` に流れ `PORTAL_URL` と不一致 | §B-11 |
| 6 | 欠陥 (修復済) | claude-review CI が両 repo で機能していなかった | §C-2 |
| 7 | 欠陥 (修復済) | readiness 6 件が一律 fail — provider inventory の sub-request 1 件の失敗が全体を道連れにしていた (他 3 原因と併せ PR #74) | §B-12 |
| 8 | 欠陥 (未発火・修復済) | Task 14 の role 分割で `SDN.Use` / `VM.Config.CDROM` が欠落し、edition2 の team VM 作成が失敗する状態だった | §B-13 |
| 9 | 欠陥 (修復済) | cleanup Operation が「実体の無い running Instance」を拾えず、Instance が `deleted` に落ちる経路が UI から存在しなかった。`previous_cleanup` が永久 fail し、次回開催が draft から上がれない状態だった (PR #77) | §B-14 |
| 10 | 欠陥 (修復済) | Archive タブが公開 list を呼んでおり DB snapshot を列挙できず、off-host verify と admin download が UI から到達不能だった (PR #78) | §B-15 |
| 11 | 欠陥 (修復済) | adopt が必要な reconcile apply が Admin Web から必ず `StaleReconciliationPlan` (409) になっていた (PR #82) | §B-16 |
| 12 | 欠陥 (修復済) | Cleanup Operation を起動するボタンが Admin Web に存在しなかった (PR #82) | §B-16 |
| 13 | 欠陥 (未発火・修復済) | Proxmox inventory の onBoot が実値によらず常に false と観測され、portal 経由の mode 遷移が onboot を片側しか切り替えない状態だった (PR #81) | §B-17 |

逸脱 1・2 は同一原因 (§B-1) で、**値を後から埋めることは原理的に不可能**。
`TBD: <human>` を残さず「実施せず」と確定させる。

### B-1. Step 4 — Pre-migration off-host snapshot → **実施せず**

**結論: 取得できなかった。値は存在しない。**

#### 何が起きたか

plan Step 4 は次を前提にしていた (plan L1496、原文):

> build/import the reviewed feature image **without changing the running
> Deployment**

この前提が構造的に成立しなかった。apphost 側の実体:

| 要素 | 実測値 | 帰結 |
| --- | --- | --- |
| Deployment の image 参照 | `ghcr.io/kisepichu/inucon-portal:latest` (`deploy/k8s/deployment.yaml:33`) | **可変 tag** |
| `imagePullPolicy` | `IfNotPresent` | node 上の同名 tag をそのまま使う |
| rollout 直前の pod 状態 | `CrashLoopBackOff` (§B-10)、backoff 上限 5 分で再起動を継続 | 数分以内に必ず次の起動が来る |
| portal 起動時の migration | `MigratorLive` が `HttpLive` / `WorkerLive` の依存 (`portal/src/main.ts:314-462`)、無条件・serve 前に実行 | 起動 = migration 適用 |

`k3s ctr images import` で `:latest` を新 image に差し替えた瞬間、
Deployment を一切触っていないのに **次の CrashLoop 再起動が新 image で
立ち上がり、migration 0004-0007 が本番 DB に適用された** (適用時刻
`2026-09-22 13:38:25`)。Deployment 更新も `kubectl apply` も不要だった。

#### なぜ「import と Deployment 更新を分離する」が破れたのか

分離が成立する条件は「Deployment が指す image 参照を import が変えない」
こと。**immutable な参照 (digest 固定、または import 専用の別 tag) で
あれば成立するが、可変 tag `:latest` + `IfNotPresent` の組み合わせでは
import 自体が Deployment の解決先を書き換える**。さらに pod が
CrashLoopBackOff で自動再起動を続けていたため、「apply しなければ
再起動しない」という暗黙の前提も同時に崩れていた。plan はこの 2 点を
どちらも明示していない。

#### 次回この手順を踏む人への回避策 (いずれか必須)

1. **import 前に `kubectl -n inucon scale deploy/inucon-portal
   --replicas=0`**。backup Job は DB PVC を直接 mount するので portal が
   0 replica でも取得できる (むしろ SQLite の排他上そのほうが安全)。
   snapshot と dry-run が終わってから `--replicas=1` に戻す。
2. **import は検証用の別 tag で行う** (`:8771812-verify` 等)。
   Deployment が指す `:latest` を上書きしない限り、既存 pod が
   何度再起動しても旧 image のままになる。
3. **恒久対策: Deployment の image をタグではなく digest で固定する**
   (`ghcr.io/kisepichu/inucon-portal@sha256:...`)。可変 tag を production
   Deployment が参照している限り、import は常に deploy と等価である。

plan / runbook 側に 1 か 2 を明文化するのが follow-up (§C-3 #1)。

#### 代償措置 (実施済)

migration 前に戻れない以上、「migration 後の状態を独立に検証して固定
する」ことに切り替えた。

- migration 適用**後**の snapshot を即時取得し、on-PVC + off-host の
  2 箇所に保持 (§B-3-2)
- off-host コピーに対して live DB とは独立に `PRAGMA integrity_check` /
  `PRAGMA foreign_key_check` / 全テーブル件数照合を実行 (§B-5)
- 公開 API 経由で edition1 の metadata と score が期待値どおりである
  ことを確認 (§B-5)

#### 残存リスク

- **migration 前の状態へ戻す手段が無い。** `docs/runbooks/contest-recovery.md`
  §10 (migration rollback) は pre-migration snapshot の存在を前提として
  いるため、**edition1 に対しては発動できない**。0004-0007 に起因する
  データ欠損が後から見つかっても復元できない。
- 緩和: 現時点の検証 (integrity / FK / 件数 / score / metadata) がすべて
  期待どおりであることと、edition1 が `finished` で以後 write されない
  ことにより、実害が顕在化する経路は限定的。ただし**これは検出であって
  復旧手段ではない**。
- 次回 (edition2 以降) の migration では §B-1 の回避策 1 か 2 を
  必ず適用し、Step 4/5 を本来の順序で実施する。

### B-2. Step 5 — Dry-run migration の突合 → **実施せず**

**結論: 実施できなかった。値は存在しない。**

理由は §B-1 と同一。dry-run の入力である pre-migration snapshot が
存在せず、本番 DB は既に 0004-0007 適用済だったため、「migration 前の
コピーに migration を当てて差分を見る」という手順が**事後に再現不可能**に
なった。`/tmp/inucon-migration-dry-run.<pid>/portal.db` は作成していない。

plan が dry-run で検証しようとしていた各項目は、代わりに
**本番適用後の実測**として §B-5 に記録した。これは「適用前に止める」
という dry-run 本来の目的 (plan L1500: *"Any mismatch stops rollout
before production DB or deployment changes"*) を**満たさない**:
差分を検知しても既に production DB は変更済で、止める先が無い。

| plan Step 5 の検証項目 | dry-run | 事後実測での代替 |
| --- | --- | --- |
| exact row counts | 実施せず | §B-5 件数表 (live / off-host 一致) |
| edition1 metadata | 実施せず | §B-5 (公開 API + DB 直読) |
| scores 1077 / 910 | 実施せず | §B-5 (実測一致) |
| instance status | 実施せず | §B-5 (`vmid=1101` / `running` 1 行) |
| job counts | 実施せず | §B-5 (`finished` 4 / `failed` 2) |
| `PRAGMA foreign_key_check` | 実施せず | §B-5 (空) |
| 差分検知 → rollout 中断 | **不可能** | — (止める先が無い) |

### B-3. Step 6 — Merge / manifest apply / image import

#### B-3-1. Merge

| 対象 | PR | base | merge commit | 内容 |
| --- | --- | --- | --- | --- |
| INUCON | [#68](https://github.com/kisepichu/inucon/pull/68) | develop | `0a009d7` | Task 15 runbook + rollout template + plan `local-lvm`→`local-zfs` 訂正 |
| INUCON | [#69](https://github.com/kisepichu/inucon/pull/69) | develop | `acab772` | VMID 反転修正 + fail-closed name 検証 (§B-9) |
| INUCON | [#70](https://github.com/kisepichu/inucon/pull/70) | **main** | `8771812` | release: develop → main |
| INUCON | [#71](https://github.com/kisepichu/inucon/pull/71) | develop | `a33d964` | CI: allowlist から `find` 除去 + turn 予算 80 (§C-2) |
| nixos-config-private | #35 | main | `6b34f25` | Task 14 agenix credential 管理 (2026-08-18 merge) |
| nixos-config-private | #36 | main | `775ae7d` | `eevee-mode.sh` の ProxyJump 既定を LAN 直結化 + 共有 lib 抽出 |
| nixos-config-private | #37 | main | `46eadbf` | claude-review に `allowedTools` + concurrency を job level へ (§C-2) |
| nixos-config-private | #38 | main | `6848e77` | claude-review の turn 予算 80 (§C-2) |

実装フェーズ (Task 1-13) の PR: #55 (Task 1) / #56 (Task 2+3 atomic) /
#57 (Task 4) / #59 (Task 5) / #60 (Task 6) / #61 (Task 7) / #62 (Task 8) /
#63 (Task 9) / #64 (Task 10) / #65 (Task 11) / #66 (Task 12) /
#67 (Task 13)。すべて `develop` に merge 済。

- main commit for image build: **`8771812`** (`Merge pull request #70 from
  kisepichu/develop`)
- 本 report 作成時の develop tip: `a33d964`

#### B-3-2. Image build / 配布

- image ID: `sha256:cc7e687da9b1627e71bbdcc9b1c78dd1a0260b757a7d451db5aac0793d690234`
- arch `amd64/linux`、node v22.23.2
- size: workstation の docker 計上 `302879029` bytes / apphost node の
  containerd 計上 `314905688` bytes (**同一 image**。docker と containerd
  で層サイズの数え方が違うだけ。同一性の根拠は image ID の一致)
- tag: `ghcr.io/kisepichu/inucon-portal:latest` および `:8771812`
  (同一 image ID に 2 tag)
- **registry は使っていない。** `docker save | gzip` → `scp` →
  `sudo k3s ctr images import`。転送 tarball
  `/tmp/inucon-portal.tar.gz` は 109400740 bytes (105 MiB)、SHA-256
  `d1e2167ea92306ce852fdb894978293095f38236a98a2b268440d4f433773a21`。
  import 時点で workstation 側と apphost 側の一致を確認済。
  apphost 側の copy は import 後に削除済のため、現在は workstation 側
  (`/tmp/inucon-portal.tar.gz`) でのみ再計算できる。
- この可変 tag `:latest` への import が §B-1 の逸脱を引き起こした。

#### B-3-3. Manifest apply

適用順序が重要:

1. `deploy/k8s/backup-pvc.yaml` (新規、`inucon-portal-backups` 5Gi
   `local-path` RWO)
2. `deploy/k8s/deployment.yaml`

`deployment.yaml` は `/backups` mount を要求する
(`deploy/k8s/deployment.yaml:54-55,79-81`) ので、**PVC を先に作らないと
Pod が Pending で詰まる**。

#### B-3-4. Rollout 結果 (2026-09-23 実測)

| 項目 | 実測 |
| --- | --- |
| pod | `inucon-portal-85657d8678-svcwv` **1/1 Running、restarts 0** |
| pod 起動時刻 | 2026-09-22T13:43:13Z |
| node | apphost (10.42.0.23) |
| container image (解決後) | `ghcr.io/kisepichu/inucon-portal:8771812` |
| container imageID | `sha256:cc7e687da9b1627e71bbdcc9b1c78dd1a0260b757a7d451db5aac0793d690234` |
| PVC `inucon-portal-data` | Bound (1Gi) |
| PVC `inucon-portal-backups` | Bound (5Gi, `pvc-404bd3d5-797c-45c9-a1fe-8572f90fea13`) |
| `BACKUP_PATH` | `/backups` (注入確認済) |
| `/backups` mount | 確認済 (`portal-post-migration-0007-20260922T134215Z.db` 212992 bytes) |

再導出:
```sh
ssh kise@192.0.2.20 'kubectl -n inucon get deploy,pod,pvc -o wide
  kubectl -n inucon get pod inucon-portal-85657d8678-svcwv \
    -o jsonpath="{.status.containerStatuses[0].imageID}"
  kubectl -n inucon exec deploy/inucon-portal -- printenv BACKUP_PATH
  kubectl -n inucon exec deploy/inucon-portal -- ls -l /backups'
```

#### B-3-5. Migration 適用結果

すべて `2026-09-22 13:38:25` に適用 (pod 起動 13:43:13 の直前、
CrashLoop 再起動での適用):

| id | name |
| --- | --- |
| 4 | `contest_lifecycle` |
| 5 | `multi_contest` |
| 6 | `operations` |
| 7 | `runner_agent_revision_text` |

既存分: 1 `initial` (2026-07-10) / 2 `selfservice` / 3
`failed_reserves_slot` (いずれも 2026-07-18)。計 7 行。

live DB の検証 (2026-09-23 再実測):

| check | 結果 |
| --- | --- |
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | 空 (0 行) |
| `journal_mode` | `wal` |
| `page_size` | 4096 |

再導出:
```sh
ssh kise@192.0.2.20 'kubectl -n inucon exec -i deploy/inucon-portal -- node -' <<'EOF'
const D=require("/app/node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3")
const db=new D("/data/portal.db",{readonly:true})
console.log(JSON.stringify(db.prepare(
  "SELECT * FROM effect_sql_migrations ORDER BY migration_id").all()))
console.log(JSON.stringify(db.pragma("integrity_check")),
            JSON.stringify(db.pragma("foreign_key_check")))
EOF
```

#### B-3-6. Post-migration snapshot

Step 4 が実施できなかった代償措置 (§B-1) として取得。

| 項目 | 値 |
| --- | --- |
| on-PVC | `/backups/portal-post-migration-0007-20260922T134215Z.db` |
| off-host | `/home/kise/backups/inucon/portal-post-migration-0007-20260922T134215Z.db` |
| off-host ディレクトリ mode | `0700` |
| SHA-256 | `4eee004cb35a3645296f709a199ea41e372a712dacf6d9c1cb53289fb91b24ca` |
| sizeBytes | `212992` |
| 3 者一致 | backup CLI の JSON metadata / on-PVC 実体 / off-host コピーで SHA-256 一致を確認 |

- 取得手段: `ghcr.io/kisepichu/inucon-portal:8771812` からの一発 Job
  (`node portal/dist/cli/backup.js --source /data/portal.db --destination
  ...`)。portal main / migrator には非依存。Job は完了後に削除、PVC は保持。
- **ファイル名の訂正:** 当初 plan Step 4 が `--destination` に指定する
  リテラル (plan L1496: `portal-before-multi-contest-<UTC timestamp>.db`)
  をそのまま使ったが、実態は migration **後**の snapshot であり名前と
  逆で監査上危険なため `portal-post-migration-0007-...` に改名した。
  backup CLI は名前を生成せず `--destination` を必須引数として受け取る
  (`portal/src/cli/backup.ts:34,48-53`) ので、これは operator 側の
  手順ミスであって CLI の挙動ではない。

再導出:
```sh
sha256sum /home/kise/backups/inucon/portal-post-migration-0007-20260922T134215Z.db
stat -c '%a %n' /home/kise/backups/inucon
ssh kise@192.0.2.20 'kubectl -n inucon exec deploy/inucon-portal -- ls -l /backups'
```

### B-4. Step 7 — Nix secret deploy と旧資格情報の retire

**状態: apphost 側は完了、benchvm 側と旧資格情報の retire は未実施。**

#### B-4-1. 実施済 (apphost)

- apphost `nixos-rebuild switch`: 実施済 (2026-08-18)。この switch が
  k3s Secret `inucon-portal-env` を旧 2 変数から split 4 変数へ
  置き換えたことが §B-10 の 502 の直接の引き金になった。
- k3s Secret `inucon-portal-env` の **キー名のみ** (値は一切記載しない、
  2026-09-23 実測 16 キー):

  ```
  ADMIN_GITHUB_LOGINS      BASE_URL
  CF_ACCOUNT_ID            CF_API_TOKEN
  CF_TUNNEL_ID             CF_ZONE_ID
  GITHUB_CLIENT_ID         GITHUB_CLIENT_SECRET
  PROXMOX_API_URL          PROXMOX_TLS_FINGERPRINT
  PROXMOX_MODE_TOKEN_ID    PROXMOX_MODE_TOKEN_SECRET
  PROXMOX_PROVISION_TOKEN_ID  PROXMOX_PROVISION_TOKEN_SECRET
  RUNNER_MAX_AGE_MILLIS    RUNNER_TOKEN
  ```

  旧 `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET` は**存在しない**
  (Task 14 で削除済)。これが §B-10 の根拠。
- portal health: `https://inucon.kisen.one/` → **200**、
  `https://inucon.kisen.one/api/health` → **200** (2026-09-23 実測)
- `pveum acl list` (2026-09-23 実測、Task 14 後の状態):

  | path | role | user | propagate |
  | --- | --- | --- | --- |
  | `/` | `Administrator` | `terraform@pve` | 1 |
  | `/` | `InuconPortal` | `portal@pve` | 1 (**旧・未 revoke**) |
  | `/nodes/eevee` | `InuconNodeAudit` | `inucon-mode@pve` | 1 |
  | `/nodes/eevee` | `InuconNodeAudit` | `inucon-provision@pve` | 1 |
  | `/pool/inucon-team-vms` | `InuconProvisionVm` | `inucon-provision@pve` | 1 |
  | `/storage/local-zfs` | `PVEDatastoreUser` | `inucon-provision@pve` | 1 |
  | `/vms/9200` | `InuconMode` | `inucon-mode@pve` | 1 |
  | `/vms/9300` | `InuconMode` | `inucon-mode@pve` | 1 |

- 権限分離の実機検証 (2026-08-18 実施): provision は `/vms/9200` に
  ACL を持たずアクセス不可、mode は `VM.Audit` / `VM.Config.Options` /
  `VM.PowerMgmt` のみ。上の ACL 表と role 定義 (§前提) が裏付けになる。
- Smoke Operation (canary VMID) / mode credential smoke
  (onboot re-write on 9200 / 9300): 2026-08-18 に実施済。
  個別の実行 ID / 時刻は当時記録していない — `TBD: <human>`
  (再実施するなら Admin Web の Operations タブから同じ smoke を
  回して Operation ID を残す)。

#### B-4-2. benchvm 側と旧資格情報の retire → **実施済 (2026-09-27 / 10-01)**

| # | 作業 | 実施日 | 結果 |
| --- | --- | --- | --- |
| 1 | benchvm 起動 | 2026-09-27 | `eevee-mode.sh contest` は onboot を devvm=0 / benchvm=1 に切り替えた後、`qm start 9200` で失敗した (下記)。SDN を復元して起動 |
| 2 | benchvm `nixos-rebuild` | 2026-10-01 | workstation から `--target-host` で switch。runner / cloudflared が agenix の EnvironmentFile に切替 |
| 3 | 旧平文 EnvironmentFile 削除 | 2026-10-01 | `/root/.inucon-tunnel-env` と `/home/kise/.inucon/runner-env` (退避した `.bak` 含む 4 ファイル) が存在しない |
| 4 | 旧 Proxmox token revoke | 2026-10-01 | `portal@pve!inucon` を削除し、`/` の `InuconPortal` ACL も削除 |

##### #1 の障害: SDN 設定が空だった

`qm start 9200` が `cannot lookup undefined type` / `QEMU exited with code 1`
で失敗した。benchvm の `net1=team1` / `net2=team2` は Proxmox SDN の vnet
だが、`/etc/pve/sdn/zones.cfg` / `vnets.cfg` / `subnets.cfg` が 3 つとも
0 バイト (mtime 2026-07-21) だった。一方 `.running-config` には最後に
適用した定義が残っていたので、それをそのまま再作成した:

- zone `inucon` (type simple, nodes eevee)
- vnet `team1` / `team2` (zone inucon)
- subnet `10.100.1.0/24` (gateway `10.100.1.1`, snat) / `10.100.2.0/24`
  (gateway `10.100.2.1`, snat)

適用前の状態は `eevee:/root/sdn-backup-20260927T133518Z/` に退避。適用は
SSH が切れても止まらないよう `systemd-run` で切り離して実行
(`pvesh set /cluster/sdn`、rc=0)。適用後も apphost は無影響
(portal pod 1/1 Running、`inucon.kisen.one` HTTP 200)。benchvm は起動し、
guest agent から `ens18 192.0.2.118` (LAN) / `ens19 10.100.1.2` (team1) /
`ens20 10.100.2.2` (team2) を確認した。

##### #2: runner の起動条件を git 非依存に変更

旧 unit は ExecStart で `git -C /home/kise/inucon rev-parse HEAD` を要求して
いたが、benchvm の配置は rsync で `.git` が無いため switch すると runner が
起動を拒否する状態だった。`nixos-config-private` PR #41 で REVISION ファイル
経由に変更し、配置手順は inucon PR #73 (`deploy/README.md` §6) に反映。

2026-10-01 の再導出:

| 項目 | 実測 |
| --- | --- |
| `/run/current-system` | `/nix/store/19mnb0pfxwqaha6sbgcqv4pfg7r1g0y4-nixos-system-benchvm-25.11.20260526.25f5383` |
| `inucon-runner` | active、EnvironmentFile `/run/agenix/runner-env`、起動 2026-10-01 13:08:17 JST |
| `cloudflared-inucon` | active、EnvironmentFile `/run/agenix/inucon-tunnel-token`、起動 2026-10-01 13:08:17 JST |
| `/home/kise/inucon/REVISION` | `a2c6b6b803a6d9d33f95169885d37f33e5b927ca` |
| portal 側 `runner_agents` | `benchvm` / revision 上記と一致 / `bench_ready=1`。`last_seen_at` が 20 秒間隔で前進することを 2 点観測で確認 |

##### #4 の監査証跡

revoke の直前に `eevee:/root/token-revoke-20261001T043451Z/` (mode 0700) へ
`acl-before.txt` / `perm-portal-before.txt` / `token-portal-before.txt` /
`user.cfg` を保存した。`user.cfg` は off-host にも写してある:

- `/home/kise/backups/inucon/pve-user.cfg-before-token-revoke-20261001T043451Z`
  (mode 0600、ディレクトリ mode 0700)。SHA-256
  `7e74297abdfffa39f1b1edba01a776a61c95d40599c770334ebce11c0778d29a`
  (eevee 側と一致)

revoke 前に、portal が新しい split credential だけで動いていることを
確認した。k8s Secret に旧 `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET` が
無いこと、両リポジトリに `portal@pve!inucon` を実際に参照している箇所が
無いこと、の 2 点。revoke 後も `/api/health` は ok、pod は restart 0。

2026-10-01 の再導出: `pveum user token list portal@pve` は空、
`pveum acl list` に `portal@pve` の行は 0 件。

### B-5. Step 8 — Edition1 の突合と archive

**状態: 突合・archive Operation・off-host verified 化まで完了 (2026-10-01)。**

#### B-5-1. edition1 metadata (2026-09-23 実測)

```
contestId        = 1ed9ebf6-a6fe-412c-a923-364fea1837b3
edition          = 1
name             = INUCON
problemKey       = private-isu
problemRevision  = legacy-2026-07-08
templateVmid     = 9100
status           = finished
instanceQuota    = 3
revision         = 1
scheduledStartAt / scheduledEndAt / accessClosesAt / cleanupAt /
accessClosedAt / cleanupCompletedAt / startedAt / finalizingAt /
finishedAt / canceledAt = すべて null
```

**`status=finished` なのに全 timestamp が null なのは正常。**
`finishContest` (`portal/src/domain/contest.ts:96-103`) は
`finalizing → finished` で `finishedAt` を刻む設計なので一見
データ不整合に見えるが、edition1 は Phase-2 の legacy 行であり
**そもそも scheduler / Operation の管理下を一度も通っていない**。
migration 0004 はこれらを back-fill せず意図的に null のまま移行する
(`portal/src/infrastructure/sql/migrations/0004_contest_lifecycle.ts:19-25`)。

> Phase-2 の legacy 行はどれも scheduler の管理下になかったので、closed
> timestamps を back-fill せず null のまま残す

安全性の根拠も同 migration のコメントにある: scheduler の due 述語は
`accessClosesAt <= now AND accessClosedAt IS NULL` であり、
`accessClosesAt=NULL` の時点で偽になる。したがって Task 12 の
`revoke_access` / `cleanup` tick が edition1 を誤って掴むことはない。

**この行の timestamp を手で埋めてはならない。** データ破損ではないので、
補完すると逆に scheduler の due 判定に引っかかり、`finished` の
edition1 に対して access 剥奪や cleanup が走りうる。

#### B-5-2. score (2026-09-23 実測)

| team | bestScore | latestScore | latestAt |
| --- | --- | --- | --- |
| team1 | **1077** | **910** | `1784382401155` |
| team2-test-name | null | null | null |

plan Step 5 の期待値 (1077 / 910) と一致。互換 endpoint
`/api/scoreboard` と contest-scoped `/api/contests/<id>/scoreboard` は
同一 JSON を返す。互換 endpoint `/api/contest` と `/api/contests` も
同一 Contest を返す。

#### B-5-3. テーブル件数

live DB (2026-09-23) と off-host snapshot
(`portal-post-migration-0007-20260922T134215Z.db`) の独立照合:

| table | live (09-23) | off-host snapshot (09-22) |
| --- | --- | --- |
| contests | 1 | 1 |
| teams | 2 | 2 |
| team_members | 2 | 2 |
| team_invites | 0 | 0 |
| instances | 1 | 1 |
| bench_jobs | 6 | 6 |
| bench_job_logs | 6 | 6 |
| users | 2 | 2 |
| sessions | **4** | **3** |
| operations | 0 | 0 |
| operation_steps | 0 | 0 |
| resource_bindings | 0 | 0 |
| contest_artifacts | 0 | 0 |
| runner_agents | 0 | 0 |
| effect_sql_migrations | 7 | 7 |

`sessions` のみ 3 → 4 に増えているが、これは snapshot 取得後の
admin ログインによるもので、**contest データではない**。他の全テーブルは
一致する。

#### B-5-4. 内容の突合

- **teams**: team1 (`team_number=1`, `desired_instance_count=1`) /
  team2-test-name (`team_number=2`, `desired_instance_count=0`)。
  plan Task 2 の「非 deleted Instance 数を quota で cap」仕様どおり。
- **instances**: 1 行のみ、`vmid=1101`, `status=running`。
  設計監査で把握済の「DB と実体の不一致 1 件」がそのまま保存されている。
  reconciliation (§B-6) の対象として**意図的に残す**。
- **bench_jobs**: `finished` 4 / `failed` 2、**全件 `purpose='competition'`**。
  plan Task 2 の backfill 仕様どおり (`purpose` 列は 0004 で追加され、
  既存行は `competition` で埋まる)。

#### B-5-5. off-host snapshot の独立検証

live DB とは別プロセス (workstation の python3 `sqlite3`) で実行:

| check | 結果 |
| --- | --- |
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | 空 |
| migrations | 7 行、id 4-7 が `2026-09-22 13:38:25` |
| edition1 metadata | live と一致 |
| bestScore | 1077 (live と一致) |
| 全テーブル件数 | `sessions` を除き live と一致 (上表) |

これが §B-1 の代償措置の中核。**pre-migration snapshot の代わりには
ならない** (戻せない) が、「適用後の状態が破損していないこと」は
独立に確定している。

#### B-5-6. Archive Operation → **実施済 (2026-10-01)**

Admin Web → edition1 → Overview タブ → 確認チェックボックス →
「archive 再生成」で実行。

| 項目 | 実測 |
| --- | --- |
| Operation ID | `48a138ae-8c85-471c-a5d6-be293823a633` |
| kind / 最終 status | `backup` / `succeeded` |
| plan digest | `backup:c1ed9ebf6-a6fe-412c-a923-364fea1837b3:r1` |
| contest revision | 1 |
| actor | admin (`cbdb4dd2-843c-4043-982e-a80cc9953165`) |
| 作成 → 開始 → 終了 (JST) | 13:58:36 → 13:58:36 → 13:58:38 (所要 2 秒) |

step は 3 件すべて attempt 1 で成功 (retry 無し):

| # | step | bytes | SHA-256 |
| --- | --- | --- | --- |
| 0 | `write_scoreboard_json` | 261 | `ba648beb473f50293f49caf1251ad2a0fe160e83083a3a598c2caaffc697f201` |
| 1 | `write_scoreboard_csv` | 169 | `da79dae41b29fe6556799f7690eda1e218aea216e08a5cf3b4b0d6def17c7e4e` |
| 2 | `write_db_snapshot` | 212992 | `d5052c67b54ae37d9635ba1d8a17f919b2d4079f9689ef645bffab5c4dcec9fb` |

##### off-host 取得と独立検証

`/home/kise/backups/inucon/` (mode 0700) に `e1-scoreboard.json` /
`e1-scoreboard.csv` / `e1-snapshot.sqlite` として取得。3 件とも
`sha256sum` が上表 (= `contest_artifacts` 列の記録値) と完全一致。

snapshot を live とは別プロセス (workstation の python3 `sqlite3`) で検証:

| check | 結果 |
| --- | --- |
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | 空 |
| contests | 1 行 (`edition=1` / `finished` / `templateVmid=9100` / `legacy-2026-07-08` / `revision=1`) |
| bestScore | 1077 |
| 件数 | teams 2 / instances 1 / bench_jobs 6 / users 2 / operations 1 / contest_artifacts 2 |

scoreboard JSON / CSV の内容も live と一致 (team1 `bestScore=1077` /
`latestScore=910` / `latestAt=1784382401155`、team2-test-name は全 null)。
CSV の列順は `teamId,teamName,bestScore,latestScore,latestAt`。

**WAL の扱い**: snapshot は WAL journal mode なので `mode=ro` で開くと
`-shm` / `-wal` が生成される。`immutable=1` で開くこと。生成して
しまった場合も `-wal` が 0 bytes なら main file は無改変
(本作業で生成 → SHA-256 一致を確認 → 側ファイル削除まで実施済)。

##### 契約の確認 — archive は状態を変えない

| 項目 | archive 前 | archive 後 |
| --- | --- | --- |
| contest status / revision | `finished` / 1 | `finished` / 1 |
| bench_jobs | finished 4 / failed 2 (全 `competition`) | 同一 |
| bestScore | 1077 | 1077 |
| Proxmox VM 一覧 | 100 / 9000 / 9100 / 9200 / 9300 (`inucon-team*` 無し) | 同一 |
| Cloudflare Access apps | 10 件 (うち `inucon-team*` 2) | 同一 |
| Cloudflare tunnel ingress | 3 件 (team1-1 / team2-1 / catch-all 404) | 同一 |
| Cloudflare DNS | 32 件 (うち `inucon-team*` 2) | 同一 |

##### off-host verified 化 (2026-10-01 17:30:41 JST)

当初 Archive タブに snapshot 行が表示されず実施できなかった (§B-15)。
PR #78 を含む image (main `8394240`) のデプロイ後に Archive タブで
snapshot の SHA-256 を再入力し verified 化した。

| kind | off_host_status | verified_at (UTC) |
| --- | --- | --- |
| scoreboard | `not_applicable` | — |
| scoreboard_csv | `not_applicable` | — |
| snapshot | `verified` | `2026-10-01T08:30:41.492Z` |

scoreboard 2 件は公開経路のため off-host 検証の対象外で、操作不要。

再導出:
```sh
# artifact の記録値 / off_host_status / 不変条件
ssh kise@192.0.2.20 'kubectl -n inucon exec -i deploy/inucon-portal -- node -' <<'EOF'
const D = require("/app/node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3")
const db = new D("/data/portal.db", { readonly: true })
console.log(db.prepare("SELECT kind,sha256,size_bytes,off_host_status FROM contest_artifacts").all())
console.log(db.prepare("SELECT edition,status,revision FROM contests").all())
console.log(db.prepare("SELECT status,purpose,COUNT(*) c FROM bench_jobs GROUP BY 1,2").all())
console.log(db.prepare("SELECT MAX(score) b FROM bench_jobs").get())
EOF

# off-host 側の独立検証 (側ファイルを作らない)
sha256sum /home/kise/backups/inucon/e1-*
python3 -c "import sqlite3;d=sqlite3.connect('file:/home/kise/backups/inucon/e1-snapshot.sqlite?immutable=1',uri=True);print(d.execute('PRAGMA integrity_check').fetchall())"

# 突合部分 (公開 API)
curl -sS http://192.0.2.20:30080/api/contests
curl -sS http://192.0.2.20:30080/api/contests/1ed9ebf6-a6fe-412c-a923-364fea1837b3/scoreboard
curl -sS http://192.0.2.20:30080/api/scoreboard   # 互換 endpoint
curl -sS http://192.0.2.20:30080/api/contest      # 互換 endpoint
python3 -c "import sqlite3;d=sqlite3.connect('file:/home/kise/backups/inucon/portal-post-migration-0007-20260922T134215Z.db?immutable=1',uri=True);print(d.execute('PRAGMA integrity_check').fetchall())"
```

### B-6. Step 9 — 初回 reconciliation apply → **実施済 (2026-10-01)**

`inucon-team*` の実体 (Proxmox VM / Cloudflare DNS) に触る唯一の
step であり、§B-4-2 #1-#3 (benchvm 起動 + agenix 切替) が前提。

- 実行方法: Admin Web → Reconciliation → **診断** → adopt 対象を個別に
  チェック → **adopt を反映した plan を取得** → **適用**
  (PR #82 以降の UI。PR #82 より前の UI では adopt 付き apply が必ず
  409 になっていた — §B-16)

#### B-6-1. 事前登録した期待 plan (2026-10-01)

**UI の出力を後から正当化しないため、押す前にコードと実測 inventory から
導出した期待値を固定しておく。**

plan の hostname key は **FQDN ではなく stem**
(`MANAGED_HOSTNAME_PATTERN = /^inucon-team\d+-\d+$/`)。desired 側は
`inucon-team{team_number}-{instance.idx}`、observation 側は Cloudflare
hostname / Proxmox VM 名の先頭ラベル。

導出の入力 (すべて 2026-10-01 実測):

| 源 | 実測 |
| --- | --- |
| DB `teams` | team1 (`team_number=1`, desired 1) / team2-test-name (`team_number=2`, desired 0) |
| DB `instances` | 1 行 (`idx=1`, `vmid=1101`, `running`, team1) |
| DB `resource_bindings` | 0 行 |
| Proxmox `listManagedVms` | 0 件 (`qm list` は 100 / 9000 / 9100 / 9200 / 9300 のみ) |
| CF routes (DNS + tunnel ingress) | `inucon-team1-1` / `inucon-team2-1` 各 1 |
| CF Access apps | `inucon-team1-1` / `inucon-team2-1` 各 1 |

`classifyHostname` に通すと entry は **2 件だけ**生成される:

| hostname | desired | VM 観測 | route/ingress/app | classification | action | reason |
| --- | --- | --- | --- | --- | --- | --- |
| `inucon-team1-1` | あり (`idx=1`, `running`) | **無し** | 1 / 1 / 1 | `missing` | `cleanup` | `vm_missing` |
| `inucon-team2-1` | 無し | 無し | 1 / 1 / 1 | `unmanaged_orphan` | `blocked` → adopt 後 `adopt_cleanup` | `requires_adopt_confirmation` → `adopted_for_cleanup` |

catch-all / `inucon` (portal) / `miniflux` / `dawarich` / `rss` /
`devvm` は `MANAGED_HOSTNAME_PATTERN` に当たらないため
**entry 自体が生成されない** (「action なしの行が出る」のではなく不在)。

route / ingress / app がいずれも 1 なので `duplicated` 判定
(いずれか > 1) には落ちない。したがって `ambiguous` は出ない。

#### B-6-2. 実測

**「診断」の plan は §B-6-1 の事前登録と完全に一致した**:

| hostname | classification | action | Proxmox VMID | CF DNS | CF ingress | CF app | reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `inucon-team1-1` | `missing` | `cleanup` | — | 1 | 1 | 1 | `vm_missing` |
| `inucon-team2-1` | `unmanaged_orphan` | `blocked` | — | 1 | 1 | 1 | `requires_adopt_confirmation` |

entry はこの 2 件だけで、catch-all / portal / 無関係リソースの行は無し。
この時点の Cleanup 欄は対象 `inucon-team1-1 — VMID なし` を表示し、
team2-1 の blocked を理由に押せない状態だった (PR #82 の設計どおり)。

- 選択した adopt: `inucon-team2-1` (stem)。UI の `requiredAdopt` は plan の
  entry から導出されるため、operator が hostname 文字列を入力する余地は
  無い (FQDN を渡す経路が存在しない)
- apply Operation ID: `879203f2-5d6c-4004-8f3c-4da3e0c0d1ad`
  (plan digest `43deb44a07687f10d485bfeec992562ab77657b7ef7398073c5b808ce2c03b74`、
  contest revision 1、actor admin)
- 作成 → 開始 → 終了 (JST): 18:58:21 → 18:58:22 → 18:58:27
- step (2 件とも attempt 1、retry 無し):
  - `reconcile:inucon-team1-1` 18:58:22 succeeded (`reconciled:inucon-team1-1`)
  - `reconcile:inucon-team2-1` 18:58:27 succeeded (`reconciled:inucon-team2-1`)
- apply Operation 最終 status: `succeeded`

apply 前後の provider 状態 (`inucon-team*` 以外に触れていないことの突合):

| 項目 | apply 前 (09:56:37Z) | apply 後 (09:59:58Z) |
| --- | --- | --- |
| CF Access apps | 10 (うち `inucon-team*` 2) | 8 (`inucon-team*` 0)。miniflux / dawarich ×3 / devvm / rss / apphost / ssh は残存 |
| CF tunnel ingress | 3 (team1-1 / team2-1 / catch-all 404) | 1 (catch-all 404 のみ) |
| CF DNS | 32 (うち `inucon-team*` 2) | 30 (`inucon-team*` 0)。`inucon.kisen.one` は残存 |
| Proxmox VM | 100 / 9000 / 9100 / 9200 / 9300 | 同一 |
| ResourceBinding | 0 | 0 (adopt 時に張った binding も CF 削除後に削除) |
| Instance (`vmid=1101`) | `running` | `running` (Instance を進めるのは cleanup) |

#### B-6-3. Cleanup Operation (Step 9 から Step 10 への橋渡し)

apply 後に再度「診断」し、Cleanup 欄の対象が `inucon-team1-1 — VMID なし`
で blocked 表示が消えたことを確認してから「cleanup 実行」。

- Operation ID: `bb39201b-5752-484a-be70-270e7664b72c`
  (plan digest `4f7edf27ae28b40c11598510f7fd579a9d16699edd72a40eb69400cb21551ac8`)
- 作成 → 開始 → 終了 (JST): 19:02:38 → 19:02:38 → 19:02:40
- step:
  - `cleanup:inucon-team1-1` 19:02:38 succeeded (`cleaned inucon-team1-1`、continueOnError=yes)
  - `cleanup:mark_completed` 19:02:40 succeeded (`cleanup_completed`)
- 最終 status: `succeeded`。Instance `vmid=1101` は `deleted` になり、
  contest は `cleanup_completed_at` が刻まれて revision 1 → 2。

これが §B-14 で「UI から存在しない」と証明した経路で、PR #77 + #82 の
修正後に初めて本番で通った。

### B-7. Step 10 — Post-cleanup 状態 → **実施済 (2026-10-01)**

§B-6 の後に実施する再監査。実測は 2026-10-01T10:05:37Z。

| 項目 | 確認方法 | 期待 | 実測 |
| --- | --- | --- | --- |
| 再 reconciliation plan | Admin Web → 診断 (contest revision 2) | 差分なし | **差分なし**。entry は `inucon-team1-1` = `in_sync` / `noop` / `managed_orphan_clean` (VMID なし、CF 0 / 0 / 0) の 1 件のみ。Cleanup 欄は「cleanup 対象はありません (既に clean)」。plan digest `c8fe6e5118f6…` |
| edition1 active Instance 数 | DB `instances` (`status != 'deleted'`) | 0 | **0** (`vmid=1101` は `deleted`) |
| Proxmox `inucon-team*` VM 数 | `ssh root@192.0.2.10 'qm list'` | 0 | **0** |
| Cloudflare `inucon-team*` DNS 数 | CF API (portal pod から) | 0 | **0** (DNS 総数 30) |
| Cloudflare `inucon-team*` tunnel ingress 数 | 同上 | 0 | **0** (ingress 総数 1) |
| Cloudflare `inucon-team*` Access app 数 | 同上 | 0 | **0** (app 総数 8) |
| catch-all record 残存 | 同上 | 残っている | **残存** (`(catch-all) -> http_status:404`) |
| edition1 score 不変 | `curl .../api/scoreboard` | 1077 / 910 | **1077 / 910** |
| portal `/api/health` | `curl -o /dev/null -w '%{http_code}' https://inucon.kisen.one/api/health` | 200 | **200** |

readiness (同時刻、Admin Web): **`previous_cleanup` が pass**
(`no residual instances from prior editions`)。次回開催を `preparing` に
上げる唯一の前提 gate が満たされた。`benchvm` は
`onBoot=true` と実値どおりに出るようになった (§B-17 の修正が本番で
有効)。`cloudflare_inventory` は `0 route(s), 0 app(s)`。

cleanup 前の baseline (2026-09-23 実測): active Instance **1**
(`vmid=1101`, `running`)、edition1 score 1077 / 910、`/api/health` 200。

#### B-7-1. return normal mode は今回実施しない

runbook §7-3 の return normal mode (benchvm 停止 → devvm 起動) は
**実施していない**。eevee は contest mode のまま (benchvm running /
onboot=1、devvm stopped / onboot=0)。

- 次回開催に必須ではない。次回開催を `preparing` に上げる gate は
  `previous_cleanup` だけで、mode は見ない。enter_contest_mode の handler は
  contest mode からは 7 step すべてが冪等で、「already」で何も変更せず
  通る設計。ただし portal にはその Operation を起動する経路がまだ無い
  (§C-3 #14)。
- 現時点では memory_check でほぼ確実に blocked になる `[INFERENCE]`。
  memory_check は benchvm 停止**後**に「node free ≥ devvm 12288 MiB +
  reserve 1024 MiB = 13312 MiB」を要求する。2026-10-01 の node free は約
  9468 MiB で、benchvm の RSS 3734 MiB (うち apphost と KSM 共有している
  分は解放されない) を足しても約 12.5〜13.2 GiB。ZFS ARC (上限 4096 MiB、
  実測 3948 MiB) は空きとして数えられない。memory_check は 8 step 中 5
  番目で、blocked になると benchvm は停止・onboot 0、devvm は停止・
  onboot 0 のまま Operation が止まり cancel が要る。
- operator 判断 (2026-10-01): devvm は第 2 回以降を数回開催するまで
  開発用途で起動する必要が無いので contest mode を維持する。メモリ設定
  (ARC 上限など) も現状のまま。

### B-8. Step 11 — Edition2 draft → **未実施**

**実開催日程が決まるまで着手しない** (plan Step 11 の条件)。

- edition2 の入力値:
  - team 数: 1 (team1 slot)
  - quota: 3
  - desiredInstanceCount: 3
  - templateVmid: 9100
  - problem revision: `TBD: <human>` (operator 供給)
  - scheduledStart / scheduledEnd (JST → UTC): `TBD: <human>` /
    `TBD: <human>` (約 7 日)
- 保存後 Contest ID: `TBD: <human>`
- Readiness 初回チェック: `TBD: <human>` (devvm 保存 + 全 pass 前は
  `preparing` に上げない)。`mode_vm_identity` check (§B-9) が
  start-required key に含まれる点に注意。

### B-9. deploy 前に修正した VMID 反転バグ (INUCON PR #69)

**plan には無い作業。rollout 直前の実機確認で発覚し、deploy をブロック
して修正した。**

#### B-9-1. 実機実測値 (eevee、2026-09-22 / 2026-09-23 に再確認)

| VM | VMID | name | memory | onboot | status |
| --- | --- | --- | --- | --- | --- |
| bench runner | **9200** | `benchvm` | 4096 | 0 | stopped |
| 開発サーバ | **9300** | `devvm` | 12288 | 1 | running |

再導出:
```sh
ssh root@192.0.2.10 'qm list; qm config 9200; qm config 9300'
```

#### B-9-2. 欠陥の内容

`portal/src/domain/modeVmIds.ts` が `DEVVM_VMID=9200` /
`BENCHVM_VMID=9300` と、実機と**完全に逆**に定義していた。

結果として新 portal は次の動作をする状態だった:

| 操作 | 意図 | 実際に起きること |
| --- | --- | --- |
| `enter_contest_mode` の devvm 停止 step | 開発サーバ (9300) を止める | **bench runner benchvm (9200) を止める** |
| `enter_contest_mode` の benchvm 起動 step | bench runner (9200) を起動 | **開発サーバ devvm (9300) を起動する** |
| `return_normal_mode` | 上の逆 | 同様に反転 |
| readiness の `benchvm` / `memory` 判定 | benchvm の状態を見る | devvm の状態を見て誤判定 |

実害の形: コンテストモードに入ろうとすると **ベンチ実行に必要な
benchvm が止まり、止めるべき開発サーバ devvm が起動したまま**に
なる。`memory` check も 4096 と 12288 を取り違えるため、
メモリ不足の判定が通ってしまう。

#### B-9-3. なぜ未発火だったか

**本番で稼働していた image が Task 8 以前 (旧 image) だったため。**
皮肉なことに §B-10 の 502 障害 (旧 image が起動できず CrashLoop) が、
この欠陥コードが本番で一度も実行されない状態を作っていた。
mode 切替は human が Admin Web から明示的に叩く操作なので、
deploy 後に誰かが `enter_contest_mode` を押すまでは発火しない。
**deploy 前に修正できたのは幸運であって、設計上の防御ではない。**

#### B-9-4. 根本原因

**設計 spec に VMID → 名前の mapping が記載されていなかった。**
`docs/superpowers/specs/2026-08-13-contest-lifecycle-automation-design.md`
は「devvm を停止して benchvm を起動する」という*名前*での記述に
終始し、どちらがどの VMID かを書いていない。Task 8 の実装時に
VMID を**推測**で埋め、レビューでも実機と突き合わせる根拠が
spec 側に無かったため、その推測がそのまま通った。

裏付けはすべて repo 内に存在していた (実装時に参照されなかっただけ):

| 根拠 | 内容 |
| --- | --- |
| `nixos-config-private/scripts/eevee-mode.sh:265-271` | `expected exactly one devvm VM named devvm with VMID 9300` / `...benchvm... with VMID 9200` |
| `nixos-config-private` commit `9314e96` | `feat(benchvm): add INUCON bench VM (vmid 9200)` |
| `deploy/README.md:261` | benchvm の IP 確認手順が `qm guest cmd 9200 network-get-interfaces` |

#### B-9-5. 修正内容 (PR #69 → `acab772`)

1. **定数訂正**: `DEVVM_VMID=9300` / `BENCHVM_VMID=9200`。
2. **observed name による fail-closed 検証** (`modeVmIdentityMismatch`)。
   power 操作 (`setVmOnBoot` / `shutdownVm` / `startVm`) の**直前**に
   inventory を再観測し、observed name が期待名 (`devvm` / `benchvm`)
   と一致しない限り `blocked` にして **retry しない**。
   呼び出し箇所: `modeOperation.ts:75`、`cleanup.ts:837`、
   `readiness.ts:304`。
3. 判定材料は **observed name のみ**。VMID から name を推定・上書き
   するような逆方向の実装にはしない (それでは mapping のズレを検出
   できない)。mismatch summary は provider raw response / credential を
   一切含まない固定文。
4. readiness に start-required な `mode_vm_identity` check を追加
   (`readiness.ts:55,289-311`)。名前不一致は `fail`。
5. `docs/runbooks/contest-recovery.md` §5 / §7 の VMID と参照行番号を
   訂正し、単発 `qm start` ではなく `eevee-mode.sh {status|normal|contest}`
   を使うよう変更。

diff 規模: 11 files, +361 / -55。誤 mapping 前提の fixture を実機値に
訂正したのは `test/support/inMemory.ts` / `readiness.test.ts` /
`cleanup.test.ts` / `proxmox.test.ts` の 4 ファイル。

検証 (2026-09-23 に `a33d964` で再実行、PR #69 の記載と一致):

| package | 結果 |
| --- | --- |
| portal | **713 passed / 2 skipped** (51 files) |
| portal/web | 33 passed (3 files) |
| runner | 14 passed (2 files) |
| 合計 | 760 passed / 2 skipped |

#### B-9-6. 教訓

> **VMID のような外部識別子は、名前で裏取りして fail closed にする。**

外部システムの数値 ID (Proxmox VMID、Cloudflare record ID、zone ID 等)
は、コード内の定数と実体の対応が**静かにズレうる**。ズレても型は通り、
テストも fixture が同じ定数を使う限り green になる。防御は次の 2 段:

1. 定数を single source of truth に置く (`domain/modeVmIds.ts`)。
2. **mutation の直前に、ID ではなく人間可読な名前で実体を再観測し、
   不一致なら止める。** retry もしない (再観測しても同じ結果なので
   retry は無意味かつ危険)。

`eevee-mode.sh` は**最初からこの形になっていた** — `qm list` を
名前で走査し (`:238-250`)、`devvm`=9300 / `benchvm`=9200 が
ちょうど 1 つずつ見つからなければ即 `exit`
(`:265-271`)。VMID を決め打ちで `qm shutdown` に渡す実装には
していない。portal 側が同じ思想を持っていれば、この欠陥は
「動くが間違っている」ではなく「起動時に止まる」になっていた。
PR #69 の修正は shell script 側の既存パターンを portal に移植した
だけである。

### B-10. 復旧した 35 日間の 502

#### B-10-1. 事象

`https://inucon.kisen.one` が **約 35 日間 502** を返していた。

| 項目 | 実測 |
| --- | --- |
| 障害中の ReplicaSet | `inucon-portal-5f454478c7` (created 2026-08-18T03:52:35Z) |
| 復旧後の ReplicaSet | `inucon-portal-85657d8678` (created 2026-09-22T13:43:13Z) |
| 間隔 | **35 日 9 時間 51 分** |
| pod 状態 | `CrashLoopBackOff`、restarts 9902 まで到達 |
| 現在 | `curl -o /dev/null -w '%{http_code}' https://inucon.kisen.one/` → **200** |

restarts 9902 は障害対応時 (2026-09-22) の観測値で、当該 pod は既に
削除されているため**再導出できない**。CrashLoopBackOff の backoff 上限
5 分から 35 日で約 10080 回という上界が出るので、値としては整合する。
ReplicaSet の作成時刻差は現在も再導出可能で、こちらが 35 日という
期間の一次証拠である。

```
Error: (Missing data at PROXMOX_TOKEN_ID:
  "Expected PROXMOX_TOKEN_ID to exist in the process context")
```

#### B-10-2. 原因

| 側 | 状態 |
| --- | --- |
| 稼働していた image | Task 8 **以前**のもの。旧 `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET` を**必須**として読む |
| k3s Secret `inucon-portal-env` | Task 14 (PR #35、2026-08-18 merge) の agenix 化で旧 2 変数を**削除**し、split 4 変数 (`PROXMOX_{MODE,PROVISION}_TOKEN_{ID,SECRET}`) に置換 |

旧 image は起動時に旧変数名を要求するが、新 Secret にはそれが存在
しない → 起動失敗 → CrashLoopBackOff。**新 image を deploy して初めて
整合する状態**を、image を deploy しないまま Secret 側だけ先に作って
しまった。

#### B-10-3. これは構造的な問題である

この障害の本質は「設定ミス」ではなく、**image と secret の更新順序に
依存する互換性の窓**である:

```
旧 image + 旧 env  → 動く
旧 image + 新 env  → 起動不能   ← 35 日間ここに居た
新 image + 旧 env  → 起動不能
新 image + 新 env  → 動く
```

env 変数の**リネーム**は、image と Secret を**同時に**切り替えない
限り必ず不整合期間を作る。しかも両者は別リポジトリ
(`inucon` / `nixos-config-private`) の別 PR で管理されており、
アトミックに切り替える手段が無い。

回避策 (いずれか):

1. **移行期間を作る**: 新 image が旧変数名も fallback として受理する
   期間を設け、Secret 切替 → image 切替 → fallback 削除 の 3 段で回す。
2. **Secret を追加のみにする**: 旧 2 変数を削除せず新 4 変数を
   *追加*し、image 切替後に旧 2 変数を消す。今回はこれをしていれば
   障害は起きなかった。
3. **起動失敗を検知する**: `CrashLoopBackOff` が 35 日間誰にも
   気づかれなかったこと自体が別の問題。外形監視が無い。

現状は 2 も 3 も未実装 (§C-3)。

#### B-10-4. 切り分け結果

**502 は portal pod 単独の問題**で、tunnel 側とは無関係だった。

- apphost の cloudflared は正常稼働 (deployment `cloudflared` 2/2
  Running、age 100d、直近 restart は 66 日前)。sshd も正常。
- `inucon.kisen.one` は **apphost のローカル ingress 経由**。
  benchvm の tunnel はチーム SSH 用であり、この経路には関与しない。
- したがって benchvm が停止していたことは 502 の原因ではない。

再導出:
```sh
ssh kise@192.0.2.20 'kubectl -n inucon get rs \
  -o custom-columns=NAME:.metadata.name,AGE:.metadata.creationTimestamp
  kubectl -n cloudflared get deploy,pod -o wide
  kubectl -n inucon get secret inucon-portal-env \
    -o go-template="{{range \$k,\$v := .data}}{{\$k}}{{\"\n\"}}{{end}}"'
curl -sS -o /dev/null -w '%{http_code}\n' https://inucon.kisen.one/
```

### B-11. apphost の IP 固定 (Step 7 の前提条件)

#### B-11-1. 問題

apphost は NetworkManager の DHCP で `192.0.2.156` を掴んでいた。
一方:

- docs 全体が `192.0.2.20` 前提
- `nixos-config-private/secrets/runner-env.age` の `PORTAL_URL` が
  `http://192.0.2.20:30080` を**焼き込んでいる**

結果、**benchvm の runner が portal に到達できない**状態だった。
§B-4-2 #1-#2 (benchvm 起動 + agenix 切替) を実行しても runner が
機能しないため、先に解消する必要があった。

#### B-11-2. 対処 — ルータ側 DHCP 予約 (採用)

選択肢は (a) apphost 側で static IP を設定 / (b) ルータで DHCP 予約。
**(b) を採用**。apphost は NixOS 管理下だが NetworkManager の DHCP を
使っており、host 側を static にすると nixos-config 側の変更が必要で
`nixos-rebuild` の失敗が即ネットワーク断に直結する。ルータ側の
予約なら apphost の設定を一切触らずに済む。

OpenWrt 25.12.5 (`192.0.2.1`, mediatek/filogic) に UCI で静的リースを
追加:

```
dhcp.@host[1].name='apphost'
dhcp.@host[1].mac='bc:24:11:16:d5:52'
dhcp.@host[1].ip='192.0.2.20'
dhcp.@host[1].dns='1'
```

dnsmasq への反映 (`/var/etc/dnsmasq.conf*` line 26):

```
dhcp-host=bc:24:11:16:d5:52,192.0.2.20,apphost
```

- `.20` は DHCP プール (`dhcp.lan.start=100`, `limit=150` →
  `.100`-`.249`) の**外**なので動的割当と衝突しない。
  投入前に ping 無応答 / ARP INCOMPLETE / 既存リース無しで空きを確認。
- `dns='1'` により `apphost.lan` → `192.0.2.20` が解決する
  (実測: `getent hosts apphost.lan` → `192.0.2.20 apphost.lan`)。
- リース更新により `.20` へ移行完了。`ssh kise@192.0.2.20` の
  `hostname` が `apphost` を返すことを確認。

再導出:
```sh
ssh root@192.0.2.1 'uci show dhcp | grep @host; uci show dhcp.lan'
getent hosts apphost.lan
ssh kise@192.0.2.20 hostname
```

#### B-11-3. 構造的な脆さ

`PORTAL_URL` が **IP アドレスを age envelope の中に焼き込んでいる**
ことが問題の本体。DHCP 予約はその症状を押さえただけで、次の性質は
残っている:

- IP を変えたくなったら **age envelope の再封入が必要**
  (`secrets/runner-env.age` の再暗号化 + benchvm の `nixos-rebuild`)。
  ルータの予約を消すだけで runner が黙って壊れる。
- 依存関係が「ルータの DHCP 予約」という**リポジトリ外の状態**に
  あり、コードレビューでは検出できない。
  `nixos-config-private/docs/devvm-operations.md:52-55` に注意書きは
  あるが、強制力は無い。

#### B-11-4. 改善案 (未実施)

`PORTAL_URL` を **`http://apphost.lan:30080`** にする。

- 利点: IP 変更に影響されない。`dns='1'` により `apphost.lan` は
  既に解決可能 (§B-11-2 で実測確認済) なので、名前解決の準備は
  完了している。
- 必要作業: age envelope の再封入 (`secrets/runner-env.age`) と
  benchvm の `nixos-rebuild switch`。
- 残る依存: `apphost.lan` の解決も結局ルータの dnsmasq に依存する。
  ただし **IP という「変わる値」ではなく name という「変えない値」に
  依存先が移る**点が改善。
- 未実施の理由: age 再封入は benchvm 停止中には検証できず、
  §B-4-2 #1-#2 と同時に実施するのが安全なため。

### B-12. readiness 6 件の一律 fail (2026-10-01、修復済)

Step 8 の archive 実行前に readiness を確認したところ、13 項目のうち
**6 件が同一文面 `Proxmox inventory unreadable` で fail**、さらに
`cloudflare_inventory` が `Cloudflare inventory read failed` で fail して
いた。本番で切り分けた結果、独立した 4 原因だった。

| # | 症状 | 根本原因 | 影響していた check |
| --- | --- | --- | --- |
| D1 | Proxmox inventory 全体が読めない | PVE 9.2.3 の `GET /nodes/:node/services/:service/state` はカスタム unit 名を**固定 enum で検証**し、404 ではなく **HTTP 400** を返す。実装は 404 だけを畳んでいたため 400 が inventory 全体に伝播 | `template` / `team_slots` / `isolation` / `memory` / `benchvm` / `mode_vm_identity` |
| D2 | `team_slots` が fail | `team1` / `team2` は Proxmox SDN の vnet (zone=inucon, type=simple) なので `/nodes/:node/network` には現れない (実測: `nic0` / `nic1` / `nic2` / `vmbr0` / `wlp4s0` の 5 件のみ) | `team_slots` |
| D3 | `template` が確認できない | template 9100 は `/pool/inucon-team-vms` 所属で、mode credential の ACL では `qm list` に出ない | `template` |
| D4 | Cloudflare inventory が読めない | `/accounts/:id/access/apps` に `per_page=5000` を渡すと **HTTP 400** (`12091 access.api.error.invalid_url_parameter_value`)。実測で `100` / `500` / `1000` は 200、`101` と `5000` は 400 (各 3 回、完全に再現) | `cloudflare_inventory` |

#### 修正 (PR #74 → develop `771e381` → main `25d87bb`)

- inventory の各フィールドを `Option` 化し、**sub-request 1 件の失敗を
  当該 check だけに閉じ込める**。reader は厳格なまま (非 2xx/404 は
  `ProxmoxError`)、集約側の `optionalSubRead` が `None` に畳む。
- `team_slots` は classic bridge と SDN vnet (`/cluster/sdn/vnets`) の
  **和集合**を取り、従来どおり benchvm の VM config の bridge と積集合。
- `template` は provision credential 経由で確認 (本番 ACL は広げない)。
- Cloudflare は `per_page=100` + `result_info.total_pages` の
  ページネーション。**途中のページで 0 件が返ったら fail-closed**
  (黙って打ち切ると reconciliation が resource を見落として誤った plan を
  出す)。これは Claude review round 1 の指摘で追加した。

#### 設計判断: `isolation` を required gate から外した

PVE 9 ではカスタム unit の状態を API から観測する手段が無い:
`GET /nodes/:node/services` の一覧も `PVE::API2::Services` の
`$service_list` という同じ固定リストしか返さず、分離の実体は生の
iptables FORWARD ルールなので Datacenter Firewall API にも現れない。

観測不能な条件を `START_REQUIRED_CHECK_KEYS` に残すと start が**恒久的に
ブロック**されるため、「観測できたとき (2xx / 404) だけ pass / fail、
観測不能 (400 等) なら **warn**」に落とした。代償として
`infra/docs/team-isolation.md` の開催前チェックリストに手動確認を 1 項目
追加した:

```sh
ssh root@192.0.2.10 "systemctl is-active inucon-team-isolation && \
  iptables -C FORWARD -s 10.100.0.0/16 -d 10.100.0.0/16 -j DROP && echo OK"
```

#### 検証

`pnpm -r typecheck` green、`pnpm -r test` green (portal 724 passed /
2 skipped、runner 14、web 33)。D1 / D2 / D4 は **mutation で実測** —
修正を巻き戻すと対応するテストが落ちることを確認した
(D1: 400 を 404 と同様に畳む → `isolation service state が 400 でも
inventory 全体は落ちず…` が fail / D2: SDN vnet 読み取りを空配列化 →
`team bridge が SDN vnet にしか無くても…` が fail / D4:
`CF_PAGE_SIZE` を 5000 に戻す → ページネーション 3 件が fail)。

#### 本番での効果 (2026-10-01、main `8394240` デプロイ後、§B-13 の ACL 変更込み)

Admin Web の Readiness タブ (edition1) の実測。修正前の 7 件 fail
(Proxmox 系 6 件 + `cloudflare_inventory`) はすべて解消し、残る fail は
事前に予測した 2 件だけになった:

| status | key | summary (実測) |
| --- | --- | --- |
| fail | `previous_cleanup` | 1 residual instance(s) still hold vmid/IP from a prior edition |
| fail | `rehearsal` | no successful rehearsal recorded for this contest yet |
| warn | `isolation` | inucon-team-isolation state is not observable via the Proxmox API; verify on eevee: systemctl is-active inucon-team-isolation |
| warn | `capacity_estimate` | estimated 12884901888B team-VM RAM exceeds post-mode free 9959845888B (linked-clone KSM recovery may make room; Task 9 will re-check per instance) |
| warn | `cloudflare_write_proven` | Cloudflare write path has not been exercised for this Contest yet |
| pass | `portal_db` | portal DB reachable |
| pass | `template` | template VM 9100 present |
| pass | `team_slots` | team slots ready: 1,2 |
| pass | `memory` | post-shutdown MemAvailable ≥ benchvm(4294967296B) + reserve(1073741824B) |
| pass | `benchvm` | benchvm inventory present (status=running, onBoot=false) |
| pass | `mode_vm_identity` | observed names match expected mapping (devvm=9300, benchvm=9200) |
| pass | `cloudflare_token` | Cloudflare API token verify: active |
| pass | `cloudflare_inventory` | Cloudflare inventory readable (2 route(s), 2 app(s)) |
| pass | `runner` | runner benchvm rev a2c6b6b803a6d9d33f95169885d37f33e5b927ca healthy (age=255ms) |
| pass | `backup` | backup canary create/fsync/delete succeeded |

- `previous_cleanup` は edition1 の Instance 1 件 (`vmid=1101`) が残っている
  ため。Step 9 / 10 の reconcile + cleanup で解消する想定 (§B-6、§B-14)。
- `rehearsal` は edition1 に rehearsal job が無いため構造的に pass しない。
  start gate は edition2 で評価する。
- `team_slots: 1,2` は §B-12 D2 (SDN vnet の和集合) と §B-13 (SDN.Audit)
  の**両方**が効いた結果。
- `benchvm` の `onBoot=false` は**誤観測**。実値は `onboot: 1`。§B-17 で扱う。

### B-13. Proxmox role 分割時の priv 欠落 (2026-10-01、修復済・未発火)

§B-12 D2 の修正は**コードだけでは効かなかった**。PVE の
`/cluster/sdn/vnets` の index は SDN ACL でフィルタされ、**権限が無いと
403 ではなく空配列**を返す。両 token で実測すると `HTTP 200 n=0`。

付与先を決めるため Task 14 で分割した role 群を旧 `InuconPortal`
(Phase 3 spike で実際の API 呼び出しから削り込んだ最小権限) と突き合わせた
ところ、**2 priv が欠落**していた。

| priv | 旧 `InuconPortal` | Task 14 後 | 必要な理由 |
| --- | --- | --- | --- |
| `SDN.Use` | あり | **無し** | team VM の NIC を SDN vnet (`team1` / `team2`) に接続する |
| `VM.Config.CDROM` | あり | **無し** | cloud-init ISO を ide2 に設定する (`qm start` が `generating cloud-init ISO` を出す経路) |

いずれも **edition2 の provisioning で初めて顕在化する潜伏バグ**で、
readiness にも archive にも出ない。今回 SDN 調査の副産物として発見した。

#### 実施した変更 (eevee、このリポジトリ外)

```sh
# readiness の vnet 可視性 (mode は read-only で足りるので SDN.Audit のみの custom role)
pveum role add InuconSdnAudit --privs SDN.Audit
pveum acl modify /sdn/zones/inucon --roles InuconSdnAudit --user inucon-mode@pve

# provision は inventory 読み取り + vnet 接続の両方が要る
pveum acl modify /sdn/zones/inucon --roles PVESDNUser --user inucon-provision@pve

# cloud-init ISO 用 priv の parity 回復
pveum role modify InuconProvisionVm --privs "VM.Allocate,VM.Audit,VM.Clone,VM.Config.CDROM,VM.Config.Cloudinit,VM.Config.Disk,VM.Config.Network,VM.Config.Options,VM.GuestAgent.Audit,VM.GuestAgent.Unrestricted,VM.PowerMgmt"
```

変更前の `pveum acl list` / `pveum role list` / `/etc/pve/user.cfg` は
`eevee:/root/acl-sdn-20261001T063921Z/` (mode 0700) に保存済。

#### 変更後の ACL (全体)

| path | role | user |
| --- | --- | --- |
| `/nodes/eevee` | `InuconNodeAudit` | mode / provision |
| `/pool/inucon-team-vms` | `InuconProvisionVm` | provision |
| `/sdn/zones/inucon` | `InuconSdnAudit` | mode |
| `/sdn/zones/inucon` | `PVESDNUser` | provision |
| `/storage/local-zfs` | `PVEDatastoreUser` | provision |
| `/vms/9200`, `/vms/9300` | `InuconMode` | mode |

#### 効果の実測

| path | 変更前 | 変更後 |
| --- | --- | --- |
| `/cluster/sdn/vnets` (mode) | `200 n=0` | `200 n=2` (`team1`, `team2`) |
| `/cluster/sdn/vnets` (provision) | `200 n=0` | `200 n=2` |
| `/cluster/sdn/zones` (両方) | `200 n=0` | `200 n=1` (`inucon`) |

`/nodes/eevee/network` は変更後も token では 4 件 (`vmbr0` が見えない)
ままだが、§B-12 D2 の和集合により `team_slots` の判定には影響しない。

### B-14. cleanup の到達性欠陥 (2026-10-01、修復済)

手順 6 (Step 9 reconciliation apply) を押す前に、apply 後に
`previous_cleanup` を pass させる経路があるかを確認したところ、**存在しな
かった**。押していたら CF resource だけが消え、Instance 行が `running` の
まま残って次回開催が永久にブロックされていた。

#### 再現 (本番 edition1 の状態をそのまま in-memory port に載せた 4 test)

| # | 操作 | 修正前の結果 |
| --- | --- | --- |
| 1 | `planReconciliation({ adoptHostnames: [] })` | `inucon-team1-1` = `missing`/`cleanup`/`vm_missing`、`inucon-team2-1` = `unmanaged_orphan`/`blocked` (§B-6-1 の事前登録と一致) |
| 2 | cleanup を先に実行 | `AmbiguousReconciliation` — cleanup は常に `adoptHostnames: []` で plan を取り直すので team2-1 の blocked を解除できない |
| 3 | reconcile apply (adopt=`inucon-team2-1`) | 2 step を enqueue。handler は `InstanceRepo` に依存しないので Instance は `running` のまま。CF 削除後に binding も `deleteById` する |
| 4 | CF clean 後に cleanup | plan は `inucon-team1-1` = `missing`/`noop`/`missing_clean_pending_db` の 1 件のみ → 対象 0 件で `NothingToReconcile` |

どちらの順序でも Instance を `deleted` に落とせない。

#### 根本原因

`cleanup.ts` の対象選択が `action ∈ {cleanup, adopt_cleanup}` または
`in_sync && (binding あり || VM 観測あり)` しか拾わず、
`missing`/`noop`/`missing_clean_pending_db` を落としていた。一方
`domain/reconciliation.ts` の当該分岐は「Instance を deleted へ進めるのは
Task 12 の役目」と、**cleanup Operation が引き取る前提**で書かれていた。
同じ選択コードが `cleanupContestResources` と `scheduleContestCleanup`
(開催終了後に scheduler が呼ぶ経路) に**コピーされていた**ため、edition2
の自動 cleanup でも同じ事象が起き得た。

#### 修正 (PR #77 → develop `74ea0f6` → main `8394240`)

選択を `needsCleanupOperation` として `classifyHostname` と同じ module に
抽出し (分岐順の不変条件 — `instanceDeleted` を `missing` より先に評価する —
と一緒に目に入る必要があるため)、2 コピーを統合。
`classification === "missing" && Option.isSome(instanceId)` を対象に追加。
`blocked` は fail-closed で常に除外。

副次的に `drifted_awaiting_reprovision` (VM 残存 + CF 全消し) も対象に
入る。旧条件はこれも漏らしており、`returnNormalMode` の
`verify_no_managed_vms` を永続 blocked にし得た。

#### 検証

| 巻き戻し | 落ちるテスト |
| --- | --- |
| `missing && instanceId` 節を削除 | `needsCleanupOperation` / admin 経路 / scheduler 経路 / 収束 の 4 件 |
| `missing` ガードを外す (deleted Instance も拾う) | 空 Operation 無限生成の防止 2 件 + 収束 1 件 |
| `blocked` の fail-closed を外す | 未 adopt orphan に触らない 1 件 |

上の再現 test 4 (デッドロックを主張する assertion) は修正後に**落ちる**
(= cleanup が成功に転じる) ことを確認した。

運用手順は `docs/runbooks/contest-operations.md` §7 に順序表として明記
(PR #80): Reconciliation apply (adopt) → Cleanup → Return normal mode。

### B-15. Archive タブの snapshot 列挙欠陥 (2026-10-01、修復済)

§B-5-6 の verified 化を Admin Web で行おうとしたところ、Archive タブに
scoreboard / scoreboard_csv の 2 行しか表示されず、`snapshot` 行
(`off_host_status=pending`) が無かった。

原因: `ArchivePanel` が**公開** list endpoint
(`/api/contests/:id/artifacts`) を呼んでおり、そちらは意図的に
`kind !== "snapshot"` で filter している。admin 用の list endpoint が
存在しなかった。verify が必要な kind は `snapshot` だけなので
`verifyArtifactChecksum` と `downloadAdminArtifact` が UI から到達不能で、
plan L1195 (「Archive lists kind/size/checksum/download/off-host status
and lets an admin confirm an off-host DB copy by re-entering the displayed
checksum」) と Task 15 Step 8 の off-host 検証を満たしていなかった。

修正 (PR #78 → develop `8a1527c` → main `8394240`): AdminOnly の
`listAdminContestArtifacts` を追加して ArchivePanel をそちらへ。download
は全 kind を admin 経路に統一。verify 入力は `pending` 行にのみ表示。
**公開 list の snapshot filter は維持**し回帰テストで固定した。

| 巻き戻し | 落ちるテスト |
| --- | --- |
| 公開 list の snapshot filter を外す | 情報漏洩回帰 1 件 |
| ArchivePanel を公開 list に戻す | Archive タブ 2 件 |

AdminOnly 境界は未認証 401 / 非 admin 403 (body に `snapshot` を含まない)
/ admin 200 をテストで固定。

### B-16. Reconciliation / Cleanup の Admin Web 導線欠陥 (2026-10-01、修復済)

§B-14 の修正をデプロイした後、手順 6 / 7 を押す前に UI の経路を
読み合わせたところ、2 件の欠陥が見つかった。どちらも押していれば
手順が進まなかった。

#### (A) adopt 付き apply が必ず stale になる

`ReconciliationPanel` は「診断」で `adoptHostnames: []` の plan を取り
(digest D0)、adopt チェック後に plan を取り直さず D0 と
`adoptHostnames: [inucon-team2-1]` を送っていた。server は adopt 付きで
plan を再計算して digest を照合する。`computePlanDigest` は
`adoptHostnames` と各 entry の `action` を含み、adopt すると
unmanaged_orphan の action が `blocked` → `adopt_cleanup` に変わるので
D1 ≠ D0 → **必ず 409**。「診断」を押し直すと adopt チェックが消えて
adopt=[] に戻るため、UI からは何度やっても apply できない。

実コードの usecase テストで確定させた: adopt=[] の digest を adopt 付き
apply に渡すと `StaleReconciliationPlan`、adopt 付きで再 plan した digest
なら通る。既存の web テストは `api.applyReconciliation` を mock して
いたため、digest の不一致を原理的に検出できなかった。

#### (B) Cleanup ボタンが無い

`OverviewPanel` の dangerous-actions は表示条件に `actions.cleanup`
(finished / canceled で true) を含んでいたが、cleanup のボタンを描画する
分岐が無かった。`api.requestContestCleanup` は定義されているだけで
呼び出し元ゼロ。edition1 は `cleanupAt` が null なので scheduler の自動
cleanup も走らない。plan L1129 (「Explicit admin apply … creates one
cleanup Operation」) と L1199 (cleanup で影響 hostname / VMID を表示し
confirmation checkbox を要求) を満たしていなかった。

#### 修正 (PR #82 → develop `d23ee27` → main `486dca8`)

- (A): adopt を全件確認すると「adopt を反映した plan を取得」が押せる
  ようになり、adopt 付きで plan を取り直して表示する。「適用」はその
  plan の digest と adoptHostnames で送る。adopt チェックを変えると
  取り直した plan は破棄される。
- (B): Reconciliation タブに Cleanup 欄を追加。対象と digest は常に
  adopt=[] の plan から取り、対象 hostname / VMID を表示して確認
  checkbox を要求する。blocked がある間は押せない。`NothingToReconcile`
  は「既に clean」と表示する。
- 対象判定は server の `needsCleanupOperation` が計算し、plan response の
  `cleanupTarget` として返す。web 側に述語を再実装しない (§B-14 の原因が
  述語の 2 コピーだったため)。plan の `cleanupTarget` が cleanup
  Operation の step と一致することを契約テストで固定。

| 巻き戻し | 落ちるテスト |
| --- | --- |
| apply の digest を adopt=[] の plan から取る | 1 件 (spy で digest を照合) |
| apply の adoptHostnames を空にする | 1 件 |
| apply 前の再 plan を外す (修正前の挙動) | 4 件 |
| web で cleanup 対象を action で選ぶ (§B-14 と同じ型) | 2 件 |

### B-17. onBoot の誤観測 (2026-10-01、修復済・未発火)

§B-12 の readiness 実測で `benchvm … onBoot=false` と出たが、
`qm config 9200` は `onboot: 1`。portal の mode token で実測すると:

```
qemu list (GET /nodes/eevee/qemu): 200
  vmid=9200 name=benchvm has_onboot_field=false onboot=undefined
  vmid=9300 name=devvm has_onboot_field=false onboot=undefined
config 9200 (GET /nodes/eevee/qemu/9200/config): HTTP 200 name=benchvm onboot=1
config 9300 (GET /nodes/eevee/qemu/9300/config): HTTP 200 name=devvm onboot=0
```

PVE 9.2.3 の qemu 一覧は onboot フィールドを返さない。adapter は Task 8
以来「qemu 一覧に onboot が含まれることがある」前提で一覧から読んでおり、
`parseOnBoot(undefined)` が false になっていた。

mode 遷移の冪等ショートカットのうち「既に 0 ならスキップ」側が常に
発火する:

| 操作 | 判定 | 結果 |
| --- | --- | --- |
| enter_contest_mode | `devvm.onBoot === false` → already 0 | devvm の onboot を 0 にしない |
| return_normal_mode | `benchvm.onBoot === false` → already 0 | benchvm の onboot を 0 にしない |

portal 経由の mode 遷移は onboot を片側しか切り替えず、eevee 再起動時に
devvm (12288 MiB) と benchvm (4096 MiB) が両方自動起動しうる状態だった。
onboot 管理は memory guard の前提 (常にどちらか一方だけ onboot=1) なので、
その不変条件が壊れていた。現時点の本番の onboot (benchvm=1 / devvm=0)
は `scripts/eevee-mode.sh contest` が設定したもので、contest mode として
正しい。portal の mode 遷移はまだ一度も本番で実行していないため未発火。

#### 修正 (PR #81 → develop `3493175` → main `486dca8`)

- onBoot は `/nodes/:node/qemu/:vmid/config` の onboot から読む (benchvm は
  bridge 読み取りと同じ response を使う。追加 request は devvm の 1 本)。
- `VmInventoryItem.onBoot` を `Option<boolean>` にし、config が読めない
  ときは None。config に onboot キーが無いのは PVE 既定値 0 なので
  `Some(false)`。「一覧に無い」と「config に無い」を区別する。
- ショートカットは `Option.contains(x.onBoot, target)` で、観測が確定して
  いるときだけスキップ。未観測なら目標値を書く。

| 巻き戻し | 落ちるテスト |
| --- | --- |
| onBoot を qemu 一覧から取る形に戻す | 6 件 |
| config が読めないとき `Some(false)` に畳む | 2 件 |
| onboot キー無しを未観測扱いにする | 1 件 |
| 未観測でもショートカットする (4 箇所) | 4 件 |
| return_normal_mode で未観測を「既に 0」とみなす (独立検証) | 1 件 |

---

## Section C: 残っている human check / 未解決事項

### C-1. 残っている human check

| 項目 | 誰が | 期日 | 状態 (2026-10-01) |
| --- | --- | --- | --- |
| benchvm 起動 (`eevee-mode.sh contest`) | operator (kisepichu) | 次の作業単位の先頭 | **実施済** 2026-09-27 (SDN 復元を伴う、§B-4-2 #1) |
| benchvm `nixos-rebuild switch --flake .#benchvm` | operator | benchvm 起動直後 | **実施済** 2026-10-01 (§B-4-2 #2) |
| benchvm 上の旧平文 `/root/.inucon-tunnel-env` / `/home/kise/.inucon/runner-env` 削除 | operator | Step 7 完了直後 | **実施済** 2026-10-01 (§B-4-2 #3) |
| 旧 `portal@pve!inucon` token revoke + ACL 削除 | operator | Step 7 smoke 完了直後 | **実施済** 2026-10-01 (§B-4-2 #4) |
| edition1 の archive Operation | operator | readiness 全 pass 後 | **実施済** 2026-10-01、off-host verified 化まで (§B-5-6) |
| 初回 reconciliation apply | operator | archive 後 | **実施済** 2026-10-01 (§B-6) |
| cleanup 後の再監査 | operator | reconciliation 後 | **実施済** 2026-10-01、`previous_cleanup` pass (§B-7) |
| enter contest mode / prepare の起動経路の追加とデプロイ | 実装 → operator (image import) | edition2 の rehearsal 前 | 未実施 (§C-3 #14) |
| edition2 draft 作成 | operator | 実開催日程の決定後 | 未実施 (§B-8) |
| edition2 rehearsal で 3 台目の払い出しが memory 判定を通るかの実測 | operator | edition2 preparing 中 | 未実施 (§C-3 #13) |
| 参加者ブラウザでの実 Access 認証 | operator | edition2 preparing → running の直前 | 未実施 |
| off-host snapshot の 3 世代保管 | operator | rollout 完了後継続 | 2 世代 (2026-09-22 post-migration / 2026-10-01 archive snapshot) |
| plan の Task checkbox を最終確定 | operator | 本 report の全 TBD 埋め後 | 未実施 |

### C-2. claude-review CI の修理 (rollout の副産物)

rollout 中に `nixos-config-private` の claude-review CI が
**一度も成功したことがなかった**ことが判明した。

#### C-2-1. 影響

claude[bot] の出力が存在する PR (2026-09-23 実測):

| PR | claude[bot] inline comment | claude[bot] issue comment |
| --- | --- | --- |
| #26 / #27 / #29 / #30 / #32 / #36 | 0 | 0 |
| #35 (Task 14 credential) | 0 | 2 (**いずれも 2026-09-23 の事後 run**) |
| #38 | 0 | 1 |

含意: **Task 14 の credential PR #35 は merge 時点 (2026-08-18) に
機械レビューを受けていない。** Proxmox token の発行スクリプトと
agenix envelope という、最も secret 事故を起こしやすい変更が
人手レビューのみで入った。

#### C-2-2. 原因 2 件

1. **`--allowedTools` が完全欠落。** これが無いと
   `github_inline_comment` / `github_comment` の MCP サーバが
   provision されず、さらに upstream 既定で Bash が全拒否されるため
   毎 turn が denial になり turn を食い潰して `error_max_turns` に至る。
   実測が 1:1 で一致する (下表)。
2. **`concurrency` が workflow レベルにあった。** workflow-level の
   concurrency は `if` gate の評価**前**に効くため、claude[bot] 自身が
   投稿したコメントが `pull_request_review_comment` を発火させ、
   `cancel-in-progress: true` で**実行中の自分自身を kill** していた。
   PR #37 で job level へ移動。

#### C-2-3. 修正前後の実測

| run | 日時 (UTC) | 対象 | subtype | turns | permission_denials | job 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| `35735668024` | 2026-09-22T13:46Z | PR #36 | `error_max_turns` | 41 | **26** | failure (`Reached maximum number of turns (40)`) |
| `35738486845` | 2026-09-22T14:10Z | PR #36 | `success` | 41 | **41** | failure (`successful result after 41 turns, exceeding the configured maximum of 40`) |
| `35839011031` | 2026-09-23T08:46Z | PR #35 (merged) | `success` | 53 | 10 | failure (`53 turns, exceeding ... 50`) — #37 適用後 |
| `35840316631` | 2026-09-23T08:59Z | PR #38 (open) | `success` | 7 | **0** | **success** — #38 適用後 |

`35738486845` は Claude 側は `success` を返しているが denial が全 41
turn に及んでおり、実質何も読めていない。`--allowedTools` 欠落の
影響がこの 2 run で最も明確に出ている。

sentinel (`CLAUDE_REVIEW: ...`) の出力状況: 修正前は 2 run とも出力
なし。`35839011031` は summary comment 内に出力。`35840316631` は
`CLAUDE_REVIEW: no issues found` を正しく出力。

再導出:
```sh
gh run view <id> -R kisepichu/nixos-config-private --log \
  | grep -oE '"permission_denials_count": [0-9]+|"num_turns": [0-9]+|"subtype": "[a-z_]+"'
```

#### C-2-4. 運用上の注意: merged PR では inline comment が出ない

`35839011031` (merged PR #35) では、Claude が完走して findings も
出したにもかかわらず inline comment を 1 件も投稿できず、
`MCP inline-comment tool unavailable` として summary comment に
フォールバックした。merged PR に対しては SDK options に `mcpServers`
が入らないためで、**`allowedTools` に列挙していても効かない**。

> **CI の動作確認は必ず open PR で行う。**
> merged PR #35 を検証対象に選んだのは手順の誤りだった。
> merged PR で確認できるのは「Claude が完走するか」までで、
> 「inline comment が投稿されるか」は確認できない。

#### C-2-5. INUCON 側 allowlist の `find` 穴

INUCON 側の workflow にも別の欠陥があった。
`--disallowedTools "Edit,Write,Agent"` で書き込みを禁じていたが、
allowlist に `Bash(find:*)` が含まれており、**`find -exec` /
`find -delete` 経由で任意の書き込み・削除が可能**だった。
allowlist 方式では列挙されたものだけが通るので、この 1 エントリが
実質的な権限境界になっていた。

PR #71 (`a33d964`) で:

- `find` を allowlist から除去し、read-only な組込み `Grep` / `Glob`
  に置換。
- prompt 内の tool 列挙も同期。**prompt と実 allowlist がずれると、
  Claude が拒否される呼び出しを試して turn を浪費する**
  (C-2-3 の denial 数がまさにこの症状)。
- `--max-turns` を 80 に (50 では Task 6/7 の大きめ PR #60 / #61 で
  不足していた)。

現在の INUCON 側設定 (`.github/workflows/claude-review.yml:85-87`):
`--max-turns 80` / allowlist は `Read,Grep,Glob,WebFetch,WebSearch` +
read-only な `Bash(...)` 群 / `--disallowedTools "Edit,Write,Agent"`。

#### C-2-6. 未解決

- **inline comment 経路は INUCON 側で「未証明」ではなく「壊れている」
  ことが確定した。** 本 report の PR (#72) の review round 1 が決定的な
  反例になった:

  | 条件 | 状態 |
  | --- | --- |
  | PR | **open** (merged ではない → MCP 不可の言い訳が立たない) |
  | allowlist | `mcp__github_inline_comment__create_inline_comment` を**明示的に含む** (`.github/workflows/claude-review.yml:86`) |
  | prompt | `Post each concrete finding as an INLINE review comment on the exact line(s) it concerns` と明示 (`:114-115`) |
  | run | `35843378352`、subtype `success`、turns 22、denials 1、`total_cost_usd` 0.861 |
  | findings | **1 件** (§B-5-1 の null timestamp 指摘) |
  | 投稿された inline comment | **0 件** |
  | 実際の投稿先 | top-level issue comment |
  | sentinel | `CLAUDE_REVIEW: 1 issue(s) -- see inline comments` — **inline を名乗るが実体は無い** |

  すなわち「open PR」「tool が allowlist 済」「prompt が inline を要求」
  「findings が存在」がすべて揃っても inline comment は投稿されない。
  §C-2-4 で疑った merged PR 固有の問題ではなく、
  **INUCON 側では恒常的に inline 経路が機能していない**。

  - `nixos-config-private`: #38 / #35 は findings が summary comment
    として届いた (#35 は merged PR のため MCP 不可、#38 は
    findings ゼロ)。こちらは依然として未証明のまま。
  - INUCON: #55-#71 に加え **#72 でも inline 0 件**。#72 では
    **findings が出た round が 2 回** (round 1 = run `35843378352`
    turns 22 / denials 1、round 3 = run `35844733378` turns 34 /
    denials 2) あり、どちらも inline 0 件で top-level に落ちた。
    単発の事故ではなく再現する。
  - **運用上の帰結:** sentinel の `-- see inline comments` を信用しては
    ならない。findings は top-level comment 側を読む。
    レビュー結果を機械的に集計する仕組みを作るなら
    `pulls/<n>/comments` ではなく `issues/<n>/comments` を見る。
  - **原因の切り分け (進行中):** run `35843378352` の `init` message には
    `message` と `model` しか無く、**`mcp_servers` フィールドが存在しない**。
    workflow 側は `enableAllProjectMcpServers: true` を設定し
    settings の allowlist にも tool 名を載せている
    (log: `Updated settings with enableAllProjectMcpServers: true`) にも
    かかわらず、である。log 中に現れる
    `mcp__github_inline_comment__create_inline_comment` 8 箇所は
    すべて `claude_args` / prompt / settings の**エコー**で、
    実際の tool 呼び出しではない。
    → **MCP サーバがそもそも provision されていない** と見るのが自然
    (ただし `permission_denials_count: 1` が何の denial だったかは
    log から特定できておらず、断定はしない)。
  - 次の一手: `anthropics/claude-code-action` が inline comment MCP を
    provision する条件を upstream 側で確認する。
    `nixos-config-private` #35 の
    `MCP inline-comment tool unavailable` という Claude 自身の申告
    (§C-2-4) と症状が一致するため、両 repo で同一原因の可能性が高い。
- **PR #35 の findings 2 件が未対応。** 事後 run
  (`35839011031`) が実際に指摘を出している:

  | # | 深刻度 | 内容 |
  | --- | --- | --- |
  | 1 | Medium | `scripts/provision-inucon-proxmox-credentials.sh:326-348` — `pve_stream_token_secret` が Proxmox 上に token を作った後、`jq` / `seal_secret` が失敗すると `set -euo pipefail` により `created_tokens+=` の**前**に exit する。`cleanup_on_fail` の EXIT trap が空配列を舐めるので token が orphan 化し、`pveum` は secret を一度しか返さないため**復旧不能**。次の `--apply` は `token already exists` で失敗する。修正: `created_tokens+=` を pipeline の**前**に移す |
  | 2 | Low | 同 `:203-204` — `check_token_absent` が SSH 失敗時に silently success を返す。`set -e` は `if` 条件内の失敗で abort しないため、`pve pveum user list` が落ちると guard がスキップされる |

  secret handling 自体は OK と判定されている (age ciphertext のみ commit、
  `LoadCredential` が `/run/agenix/` の runtime path を使用、
  `seal_secret` が平文を disk に書かない、`secrets.nix` の recipients と
  `owner` が consumer と一致)。

### C-3. 未解決の構造的課題

| # | 課題 | 根拠 | 提案 |
| --- | --- | --- | --- |
| 1 | production Deployment が可変 tag `:latest` を参照しており、image import が deploy と等価になる | §B-1 | Deployment の image を digest 固定にする。最低でも plan / `deploy/README.md` に「import 前に `--replicas=0`」または「検証は別 tag で」を明記 |
| 2 | env 変数のリネームが image / Secret の更新順序に依存し、不整合期間を必ず作る | §B-10-3 | Secret は「追加のみ → image 切替 → 旧キー削除」の 3 段に分ける |
| 3 | `CrashLoopBackOff` が 35 日間検知されなかった (外形監視が無い) | §B-10-1 | `https://inucon.kisen.one/api/health` の外形監視を追加する |
| 4 | pre-migration snapshot が存在せず、edition1 に対して recovery runbook §10 が発動不能 | §B-1 残存リスク | edition2 以降で Step 4/5 を本来の順序で実施。§C-3 #1 が前提 |
| 5 | `PORTAL_URL` が IP を age envelope に焼き込んでおり、ルータの DHCP 予約という repo 外の状態に依存する | §B-11-3 | `http://apphost.lan:30080` に変更 (§B-11-4) |
| 6 | 設計 spec に外部識別子 (VMID) の mapping が無い | §B-9-4 | spec に mapping 表を追加。実装は名前で fail-closed 検証する (§B-9-6) |
| 7 | claude-review の inline comment が **INUCON 側で恒常的に投稿されない** (open PR + allowlist 済 + findings ありでも 0 件)。`nixos-config-private` 側は未証明のまま | §C-2-6 | upstream の MCP provision 条件を確認。当面は sentinel の `-- see inline comments` を信用せず `issues/<n>/comments` を読む |
| 8 | `nixos-config-private` PR #35 の Medium / Low findings 2 件が未対応 | §C-2-6 | `provision-inucon-proxmox-credentials.sh` の修正 PR を立てる |
| 9 | off-host snapshot が 1 世代のみ | §B-3-6 / §C-1 | 3 世代ローテーションを運用に入れる |
| 10 | `getInstanceInventory` が managed app 1 件ごとに `getPolicies` を呼ぶが、得られる `policyShape` / `emailSetHash` は**どの判定にも表示にも使われていない** (`classifyHostname` は受け取らない。client.ts の「planner は emailSetHash で drift を検出できる」は未実装の願望)。plan refresh ごとに team 数の CF API call を無駄に払っており、CF は 429 を踏みやすい | 2026-10-01 のコード走査 (`policyShape` / `emailSetHash` を `portal/src` `portal/web` `shared/src` から検索し、消費箇所がゼロ) | drift 検出を実装するか、inventory から policy 取得を外す。どちらかに決める |
| 11 | Proxmox role / ACL が repo 外 (eevee のローカル状態) にしか無く、Task 14 の分割時に旧 `InuconPortal` から `SDN.Use` / `VM.Config.CDROM` が落ちたことが**どの検証にも引っかからなかった** | §B-13 | `pveum role list` / `pveum acl list` の期待値を `nixos-config-private` 側に置き、`eevee-ops-test.sh` 相当で突合する |
| 12 | readiness `capacity_estimate` が「team ごとの `instanceQuota` × 4 GiB」で計算しており**チーム数を掛けていない**。複数チームの開催では必要 RAM を過小に見積もる。warn 専用で、実際の安全判定は Task 9 の 1 台ごとの判定 (`PROVISION_MIN_FREE_MEM_BYTES`、既定 5,000,000,000 B) なので過剰に詰め込む害は無い | `readiness.ts` の `capacityEstimateCheck` (`desiredTotal = contest.instanceQuota * estimatedPerVm`)、`domain/contest.ts` の「チームごとのインスタンス上限」 | Σ team の `desiredInstanceCount` × template の割当 RAM で見積もる |
| 13 | メモリ判定が ZFS ARC (上限 4096 MiB、2026-10-01 実測 3948 MiB) を空きとして数えない。return normal mode の memory_check (node free ≥ 13312 MiB) は現状ほぼ確実に blocked。edition2 計画 (1 チーム × 3 台) の 3 台目も clone 直前の空き 4768 MiB を満たすかが KSM による共有量次第。物理的には 3 台入る | §B-7-1、2026-10-01 の `free -m` / `arcstats` / `pvesh get /nodes/eevee/status` | edition2 の rehearsal で 3 台目が通るかを実測する。通らなければ ARC 上限を下げる (`/sys/module/zfs/parameters/zfs_arc_max`、再起動不要) か `PROVISION_MIN_FREE_MEM_BYTES` を見直す |
| 14 | enter_contest_mode (Task 8) と prepare (Task 9) の Operation を**起動する経路が無い**。handler・step・テストは実装済みで、OperationHandlerRegistry にも登録されているが、HTTP endpoint・UI・scheduler のどこからも enqueue されない (enqueue される kind は backup / cleanup / finish / return_normal_mode / revoke_access / reconcile / start の 7 つだけ)。edition2 の rehearsal 前に prepare が必須。spec L262 と plan L1199 は mode 切替を operator が確認付きで起動する操作として要求している。あわせて readiness.ts の `PREPARATION_REQUIRED_CHECK_KEYS` / `PREPARATION_BLOCK_KEYS` も参照ゼロ (gate 自体は `beginContestPreparation` が同じトランザクション内で直接判定しているので安全上の穴ではない) | 2026-10-01 のコード走査 (usecase の export のうちコメントを除いたコードで参照が定義行だけのもの: `buildEnterContestModeSteps` / `prepareContest` / 上記 2 定数) | AdminOnly endpoint と Overview のボタン (影響 VMID / hostname 表示 + 確認 checkbox) を追加する。修正は別 PR で進行中 |

---

## Section D: Commit history (このリポジトリ側)

フォーマット: `<short hash> <ISO date> <one-line subject> [role]`

### D-1. INUCON (`kisepichu/inucon`) — Task 15 以降

```
a33d964  2026-09-23  fix(ci): claude-review の allowlist から find を外し turn 予算を 80 にする (#71)  [sub-agent]
8771812  2026-09-22  Merge pull request #70 from kisepichu/develop                                    [human]
acab772  2026-09-22  fix(ops): correct inverted devvm/benchvm VMIDs and verify VM names (#69)       [sub-agent]
0a009d7  2026-08-18  docs(contest): recovery runbook + rollout evidence template (Task 15 sub-agent scope) (#68)  [sub-agent]
```

`0a009d7` は squash merge のため、A-1 の runbook 差分 / 本ファイルの
template / plan storage typo fix (`local-lvm` → `local-zfs`) が 1 commit に
同居する。PR #68 のブランチ上では `b22b89d` (review round 1 対応) /
`3b1dab9` (round 2) / `fed1171` (round 3) に分かれていた。

実装フェーズ (Task 1-13) の merge commit:

```
26254b6  Task 13  feat(web): add contest operations console (#67)
63cd977  Task 12  feat(ops): automate contest resource closeout (#66)
fc21cc7  Task 11  feat(contest): finalize schedules and archive results (#65)
b4ed076  Task 10  feat(contest): add rehearsal and guarded start (#64)
06e063d  Task 9   feat(ops): converge contest instances and access (#63)
51043ab  Task 8   feat(ops): add safe contest mode switching (#62)
9b5c304  Task 7   feat(ops): reconcile provider resources (#61)
2f90edb  Task 6   feat(ops): add durable operation worker (#60)
fe9ffd1  Task 5   feat(admin): add contest setup wizard (#59)
586c66a  Task 4   feat(portal): expose contest archives (#57)
e5c602a  Task 2+3 feat(portal): scope repositories by contest (atomic) (#56)
38a2837  Task 1   feat(contest): define multi-edition lifecycle (#55)
51bc72d  —        docs: 複数開催回・運営自動化の設計スペックと実装計画 (#51)
```

本 report を埋めた commit: このファイルの変更を含む commit (human /
sub-agent 協働)。`git log --oneline -- docs/superpowers/reviews/2026-08-13-contest-lifecycle-rollout.md`
で追える。

### D-2. `kisepichu/nixos-config-private` (sibling repo) の参照 commit

```
6848e77  2026-09-23  fix(ci): claude-review の turn 予算を 80 に上げる (#38)
46eadbf  2026-09-23  fix(ci): claude-review に allowedTools を与え concurrency を job level へ移す (#37)
775ae7d  2026-09-22  fix(eevee): eevee-mode.sh の ProxyJump 既定を LAN 直結にする (#36)
6b34f25  2026-08-18  feat(inucon): manage runtime credentials with agenix (Task 14) (#35)
9314e96  —           feat(benchvm): add INUCON bench VM (vmid 9200)     ← §B-9-4 の裏付け
```

再導出:
```sh
gh pr list -R kisepichu/inucon --state all --limit 25 \
  --json number,title,state,mergeCommit,baseRefName
gh pr list -R kisepichu/nixos-config-private --state all --limit 15 \
  --json number,title,mergeCommit,mergedAt
```

---

## Section E: 参照

- Plan: `docs/superpowers/plans/2026-08-13-contest-lifecycle-automation.md`
- Design spec: `docs/superpowers/specs/2026-08-13-contest-lifecycle-automation-design.md`
- Recovery runbook: `docs/runbooks/contest-recovery.md`
- Ops runbook: `docs/runbooks/contest-operations.md`
- Deploy runbook: `deploy/README.md`
- Final Verification Matrix: plan 末尾 (§Final Verification Matrix)
- VMID single source of truth: `portal/src/domain/modeVmIds.ts`
- mode VM の名前検証 (先行実装): `../nixos-config-private/scripts/eevee-mode.sh:238-271`
- apphost の IP 前提: `../nixos-config-private/docs/devvm-operations.md:52-55`
- backup CLI: `portal/src/cli/backup.ts`
- backup PVC: `deploy/k8s/backup-pvc.yaml`
- claude-review workflow: `.github/workflows/claude-review.yml`
