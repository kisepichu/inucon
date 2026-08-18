# Contest lifecycle automation rollout evidence

**Plan:** `docs/superpowers/plans/2026-08-13-contest-lifecycle-automation.md`
Task 15 (Recovery runbooks, full verification, reviewed rollout, and first
reconciliation)。本 report は Task 15 Step 12 の deliverable。

**Scope:** 実装フェーズ (Task 1-13) + agenix source of truth (Task 14) +
runbook / verification (Task 15 Step 1-3) の完了、および人手フェーズ (Task
15 Step 4-11) の rollout evidence を残す。

**Secret handling:** この report に token / API key / Cloudflare secret /
Access 許可 email / SSH 鍵 / Authorization header / OAuth secret を絶対
に書き込まない。値はすべて `../nixos-config-private/secrets/*.age`
(agenix) 側で管理する。commit 前に `grep -E
'token|secret|password|email|Authorization|Bearer'` で本ファイルを走査
すること。

## 前提

- Task 14 実施状態 (2026-08-18 時点):
  - Proxmox pool: `inucon-team-vms` (template `9100` 収容)。
  - users: `inucon-provision@pve`, `inucon-mode@pve` (password なし)。
  - tokens: 両 user に `portal-2026-08-18a` サフィックスの API token を
    2 本発行済み。旧 `portal@pve!inucon` は Step 7 の smoke 完了確認まで
    温存。
  - storage: **`local-zfs`** (plan 本文の `local-lvm` は誤記、Task 15
    で修正済み。commit `TBD: <human>` — plan storage fix commit の
    hash)。

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

commit: `TBD: <human>` — runbook + storage typo fix commit hash
(`git log --oneline feat/contest-rollout-docs` から)

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

- PR: `TBD: <human>` (`gh pr view <n> --json url,mergeCommit,state`
  の抜粋。マージ後の develop commit hash を残す)
- review workflow: `/pr-review claude`
  - round 1 findings: `TBD: <human>` 件、対応: `TBD: <human>`。
  - round 2 findings: `TBD: <human>` 件、対応: `TBD: <human>`。
  - round 3 findings: `TBD: <human>` 件、対応: `TBD: <human>`。
  - 4 round 目に達した場合: high/critical のみ対応、それ以外は
    follow-up として PR コメントで受領 (`TBD: <human>` にコメント URL)。
  - max-turns 失敗時の `@claude review` 再トリガ有無: `TBD: <human>`。
- develop merge commit: `TBD: <human>`
- release notes / changelog に相当する Contest 変更点: このリポジトリは
  changelog を持たないため PR description に集約。

---

## Section B: 人手担当 (Task 15 Step 4-11)

以下は human operator が rollout 実施時に埋める。sub-agent は雛形のみ
提供する。すべての `TBD: <human>` に値を入れた commit を別途作る。

### B-1. Step 4 — Pre-migration off-host snapshot

- ホスト: `TBD: <human>` (WSL 側 `~/backups/inucon/` mode 0700)
- ファイル名: `portal-before-multi-contest-<UTC>.db` (実際の UTC:
  `TBD: <human>`)
- Job 完了時刻 (UTC): `TBD: <human>`
- SHA-256 (off-host 計算): `TBD: <human>`
- `PRAGMA integrity_check` 結果: `TBD: <human>` (期待: `ok`)
- CLI JSON metadata の SHA-256 との一致: `TBD: <human>` (期待: match)
- backup Job のみ削除・Deployment 未変更を確認: `TBD: <human>`

### B-2. Step 5 — Dry-run migration の突合

- コピー先: `/tmp/inucon-migration-dry-run.<pid>/portal.db`
- 対象 image / migrator commit: `TBD: <human>`
- edition1 metadata (Contest 行、edition, name, dates): `TBD: <human>`
- scores: 1077 / 910 (期待値)、実測 `TBD: <human>`
- instance status 分布: `TBD: <human>`
- job counts (queued / running / finished / failed / canceled):
  `TBD: <human>`
- `PRAGMA foreign_key_check`: `TBD: <human>` (期待: 空)
- 差分検知 → 中断有無: `TBD: <human>`

### B-3. Step 6 — Merge / manifest apply / image import

- INUCON PR (feature): `TBD: <human>` (URL + merge commit)
- INUCON PR (develop → main): `TBD: <human>` (URL + merge commit)
- `nixos-config-private` credential PR: `TBD: <human>`
- main commit for image build: `TBD: <human>`
- image digest (apphost `k3s ctr images list` 側):
  `TBD: <human>` (`sha256:...`)
- rollout status: `TBD: <human>` (`kubectl -n inucon rollout status
  deployment/inucon-portal`)
- backup PVC apply 確認: `TBD: <human>` (Bound, mount path
  `/backups`)

### B-4. Step 7 — Nix secret deploy と旧資格情報の retire

- apphost `nixos-rebuild switch` (人手): `TBD: <human>` (時刻 UTC)
- k3s Secret `inucon-portal-env` の **キー名のみ** 一覧
  (`kubectl -n inucon get secret inucon-portal-env -o jsonpath='{.data}'
  | jq keys`): `TBD: <human>` (値を書かない)
- portal health: `TBD: <human>` (`curl -s -o /dev/null -w '%{http_code}\n'
  https://inucon.kisen.one/api/health` = 200)
- Proxmox provision credential read-only inventory 実行結果:
  `TBD: <human>`
- Proxmox mode credential read-only inventory 実行結果:
  `TBD: <human>`
- Smoke Operation (canary VMID `TBD: <human>`) 結果:
  absent → clone → observe → delete → absent すべて `TBD: <human>`
- Mode credential smoke (onboot re-write on 9200 / 9300): `TBD: <human>`
- `pveum acl list` 差分 (Task 14 前後): `TBD: <human>`
- `/etc/pve/user.cfg` snapshot 保存先 (mode 0700 off-host):
  `TBD: <human>`
- 旧 token `portal@pve!inucon` の revoke 実施 (人手, `pveum user token
  remove`): `TBD: <human>`
- 旧平文 EnvironmentFile 削除 (`/home/kise/.inucon/runner-env` 等):
  `TBD: <human>`

### B-5. Step 8 — Edition1 の突合と archive

- pre-migration との公開 API 差分: `TBD: <human>` (期待: 差分なし)
- Instance 台帳の team1-1 が残っているか (reconciliation 用):
  `TBD: <human>`
- Archive Operation ID: `TBD: <human>`
- scoreboard JSON SHA-256: `TBD: <human>`
- scoreboard CSV SHA-256: `TBD: <human>`
- DB snapshot artifact SHA-256: `TBD: <human>`
- off-host download 先 (mode 0700): `TBD: <human>`
- provider mutation が発生していない確認: `TBD: <human>`

### B-6. Step 9 — 初回 reconciliation apply

- Refresh 後 plan 内容 (要約):
  - team1-1: missing Proxmox VM + Cloudflare cleanup (期待)、実測
    `TBD: <human>`
  - team2-1: unmanaged Cloudflare orphan blocked (期待)、実測
    `TBD: <human>`
  - catch-all / portal / 無関係 resource: no action (期待)、実測
    `TBD: <human>`
- 選択した adopt hostname: `inucon-team2-1.kisen.one`
- apply Operation ID: `TBD: <human>`
- step 遷移: `TBD: <human>` (queued → running → succeeded の時刻)
- apply Operation 最終 status: `TBD: <human>` (期待: succeeded)

### B-7. Step 10 — Post-cleanup 状態

- 再 reconciliation plan: `TBD: <human>` (期待: 差分なし)
- edition1 active Instance 数: `TBD: <human>` (期待: 0)
- Proxmox `inucon-team*` VM 数: `TBD: <human>` (期待: 0)
- Cloudflare `inucon-team*` DNS 数: `TBD: <human>` (期待: 0)
- Cloudflare `inucon-team*` tunnel ingress 数: `TBD: <human>`
  (期待: 0)
- Cloudflare `inucon-team*` Access app 数: `TBD: <human>` (期待: 0)
- catch-all record が残存: `TBD: <human>` (期待: 残っている)
- edition1 score 不変: `TBD: <human>` (期待: rollout 前と一致)
- portal `/api/health`: `TBD: <human>` (期待: 200)

### B-8. Step 11 — Edition2 draft

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
  `preparing` に上げない)

---

## Section C: 残っている human check

| 項目 | 誰が | 期日 |
| --- | --- | --- |
| 旧 `portal@pve!inucon` token revoke | operator (kisepichu) | Step 7 smoke 完了直後 |
| 旧平文 `/home/kise/.inucon/runner-env` 削除 | operator | Step 7 完了直後 |
| 参加者ブラウザでの実 Access 認証 | operator | edition2 preparing → running の直前 |
| off-host snapshot の 3 世代保管 | operator | rollout 完了後継続 |
| plan (`docs/superpowers/plans/2026-08-13-contest-lifecycle-automation.md`) の Task checkbox を最終確定 | operator | 本 report の全 TBD 埋め後 |

---

## Section D: Commit history (このリポジトリ側)

`TBD: <human>` — 人手記入。以下のフォーマットで並べる:

```
<short hash> <ISO date> <one-line subject> [role: sub-agent | human]
```

含めるべき commit (期待):
- runbook + plan storage typo fix (sub-agent)
- rollout report template (本ファイル、sub-agent)
- rollout report を埋めた commit (human)
- `nixos-config-private` 側 commit hash 参照 (human、sibling repo)

---

## Section E: 参照

- Plan: `docs/superpowers/plans/2026-08-13-contest-lifecycle-automation.md`
- Design spec: `docs/superpowers/specs/2026-08-13-contest-lifecycle-automation-design.md`
- Recovery runbook: `docs/runbooks/contest-recovery.md`
- Ops runbook: `docs/runbooks/contest-operations.md`
- Deploy runbook: `deploy/README.md`
- Final Verification Matrix: plan 末尾 (§Final Verification Matrix)
