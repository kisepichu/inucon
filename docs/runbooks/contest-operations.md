# コンテスト運営手順(runbook)

INUCON 開催の前日〜当日〜終了後の作業。デプロイ自体は `deploy/README.md` を参照。
操作の主体: 「Admin UI」= https://inucon.kisen.one の Admin ページ(`ADMIN_GITHUB_LOGINS`
のユーザーでログイン)。

## コンテストの状態機械(前提知識)

`preparing → running → finished` の**一方向**(`portal/src/domain/contest.ts`)。

- ベンチ実行(enqueue)は **running のみ**可(`ContestNotRunning` で拒否)。
- インスタンスの追加/削除・招待は状態に依らず可能(事前払い出しを許す設計)。
- Scoreboard は常時表示。
- **リセット遷移は無い**。同じ DB で 2 回目のコンテストを開催するには DB 作業が要る
  (下記「次回開催に向けて」)。contest 行は seed(新規 DB 起動時)が
  `INUCON / private-isu / preparing / quota 3` を 1 行作る。

## 開催前(前日まで)

1. **デプロイ確認**: 本番が main と同一か。`/api/health` 200。
2. **ランナー確認**(benchvm): `systemctl status inucon-runner` が active、
   `journalctl -u inucon-runner -f` で poll が回っている。benchvm の IP は DHCP で変動
   するため、ポータル側 `PORTAL_URL` 到達性も含めて 1 度ベンチを通しで確認しておく。
3. **チーム作成**(Admin UI): チーム名 + チーム番号(1-254)。
4. **メンバー招待**(Admin UI → 招待): githubLogin + **Access ログイン用 email**。
   - 未ログインのメンバーは「招待作成(pending)」になり、初回 GitHub ログイン時に
     自動でチームに入る。
   - 結果カードの warnings(email 未登録で Access に載らなかった等)を必ず確認。
5. **インスタンス払い出し**: 各チームの Team ページから追加(メンバー自身でも可)。
   quota はコンテスト行の `instance_quota`(既定 3)。eevee の空きメモリが閾値
   (既定 5GB)未満だと `InsufficientMemory` で弾かれる。
   - 目安: VM 1台 4GiB。KSM がクローン間の同一ページを統合するため、起動から数分で
     実効使用量は下がる(直後に閾値割れでも回復し得る)。
6. **SSH 開通確認**: 各メンバーが `ssh isucon@inucon-team{N}-{M}.kisen.one` で入れること
   (Cloudflare Access のメール認証 → 鍵認証)。招待した email 以外では認証メールが
   届かないこと(deny)も 1 アカウントで確認しておくと確実。
7. **リハーサル**: どこかのチームでベンチを 1 回実行し、スコアが Scoreboard に出る
   ところまで通す。

## 開始時

1. Admin UI → コンテスト → **「開始」**(preparing → running)。
2. 確認: Team ページからベンチが enqueue でき、runner が拾って finished になること。

競技中の監視(必要に応じて):

```sh
# ポータルのログ
ssh apphost.kisen.one 'kubectl -n inucon logs deploy/inucon-portal -f --tail=50'
# ランナーのログ(benchvm)
ssh kise@<benchvm-ip> 'journalctl -u inucon-runner -f'
# eevee の負荷/メモリは WebUI(https://192.0.2.10:8006)
```

- ベンチはグローバル直列(同時 1 本)。詰まって見えるときはジョブ一覧の queued 数と
  runner ログを確認。ジョブは `JOB_TIMEOUT_MILLIS`(既定 10 分)で自動 fail 回収される。
- インスタンスが `failed` になった場合: エラー内容を確認 → そのインスタンスは
  チーム自身(or admin)が削除すれば片付く(補償 saga が実 VM/CF リソースを掃除する)。

## 終了時

1. Admin UI → コンテスト → **「終了」**(running → finished)。
   以降ベンチは enqueue できない(実行中のジョブは完走 or タイムアウト回収)。
2. 結果の記録: Scoreboard を確認・保存(必要ならスクリーンショット、または
   `GET /api/scoreboard` の JSON を保存)。
3. **注意**: finished にしてもチーム VM への SSH アクセスは遮断されない
   (アクセス遮断の仕組みは未実装 = 今後対応として記録済み)。講評期間など
   アクセスを残したい場合はそのままで良い。

## 後片付け(結果確定後)

1. **セルフサービス製インスタンスの削除**: 各チームの Team ページ(or admin)から削除。
   teardown が VM 停止/破棄・CF ルート・Access アプリまで掃除する。
   チーム内の削除は 1 台ずつ直列(進行中 1 本ガード)。
2. **terraform 製 VM**(Phase 1 で作った分)はポータルから消さず、`infra/` の
   `terraform destroy`(または該当リソースの削除)で片付ける。台帳と実体の管理者が
   異なるため混ぜない。
3. **DB バックアップ**: `deploy/README.md` のスナップショット手順で結果込みの DB を
   保存しておく。

## 次回開催(第 n 回)を作る

Task 1-13 (contest lifecycle automation) 以降、開催回は Admin Web の
**Contests → 新規作成** から draft として複数作れる。第1回 (INUCON) は
`finished` のまま履歴として残り、Team / Invite / Instance / BenchJob /
scoreboard は開催回ごとに分離される。手順の全体像:

1. Contests → **新規作成 (draft)** → 5-step wizard (基本情報 / 問題 revision /
   quota / 期間 / Team 編成コピー) を埋める。**日付は operator が確定した
   値を入力する (推測しない)**。desiredInstanceCount / instanceQuota は第2回
   でも設定値であり、コード側にハードコードしない (Global Constraints)。
2. ContestAdmin → **Reconciliation** タブで **診断** → adopt 対象 hostname を
   個別にチェック → **adopt を反映した plan を取得** (action が `adopt_cleanup`
   に変わることを確認) → **適用**。差分ゼロを確認。
3. ContestAdmin → **Overview** で開催準備を進める。Overview の操作はこの順に
   並び、それぞれ対象の Contest 状態でだけ表示される:
   - 3-1. **「準備開始」**(draft → preparing)。状態を変えるだけで外部リソースは
     触らない。前回開催の Instance が残っている (`previous_cleanup`) / 未完了
     Operation がある / 遷移中 Instance がある場合は
     `ContestNotReadyForPreparation` (409) で拒否される。
   - 3-2. **「競技モード切替」**(spec §3、`enter_contest_mode` Operation)。確認欄に
     出る VM / VMID (devvm 9300 を onboot=0 → guest shutdown、空きメモリ確認後に
     benchvm 9200 を onboot=1 → 起動) を確認して「影響を確認しました」→ 実行。
     VMID は portal が `portal/src/domain/modeVmIds.ts` から返した値。遷移先の
     Operation 詳細で全 step が succeeded になるのを待つ。既に競技モードなら全 step
     が何も変更せず succeeded で終わる。shutdown が timeout して blocked になったら
     `contest-recovery.md` §5 (force stop はしない)。
   - 3-3. **「インスタンス準備」**(spec §4、`prepare` Operation)。確認欄に作成予定の
     hostname / VMID と台数、既に Instance がある枠 (作り直さない) が出るので確認して
     実行。全 team を desiredInstanceCount まで **1 台ずつ** 作り、running が 1 台でも
     あれば空きメモリが閾値に戻るまで KSM 統合を最大 10 分待つ。競技モードでない
     (devvm が停止していない / benchvm が起動していない / 観測できない) と
     `ContestModeNotActive` (409) で拒否されるので、先に 3-2 を完了させる。blocked
     の summary が `ksm_settle_timeout:*` なら `contest-recovery.md` §6、
     `all_slots_consumed_*` なら failed の Instance が枠を占有している。
   - 3-4. 招待 (Admin ページの招待フォーム) と **「rehearsal 実行」**。インスタンス準備の下の
     rehearsal 欄で対象 Instance (running の枠だけが hostname / VMID / team 付きで選べる) を
     選び、「影響を確認しました」→ **rehearsal 実行**。選んだ Instance に本番と同じ
     ベンチマーカーが 1 回走り、**実際に負荷がかかる** (対象を変えると確認し直しになる)。
     running の Instance が無いと押せない (先に 3-3 を完了させる)。投入後に出る job の
     リンク先 (job 詳細) で queued → running → finished / failed、判定 (pass / fail)、
     score、ログを確認する。readiness の rehearsal は **finished かつ判定 pass** の
     rehearsal が 1 件以上あると pass になる (score は問わない。finished でも判定 fail は
     数えない)。job へのリンクは投入した画面にしか出ないので、離れた後は Readiness タブの
     rehearsal で成功件数を見る。queued のまま進まないときは Readiness タブの runner
     (heartbeat / benchReady) を確認する。拒否されたとき:
     - `RehearsalInstanceNotRunning`: 選んだ Instance が running でない。ページを再読み込み
       して Instance の状態 (3-3 の完了) を確認する。
     - `TeamJobAlreadyQueued`: そのチームに queued / running の rehearsal が既にある。
       finished / failed になってから再実行する。
   - 3-5. **Readiness** タブで runner heartbeat / backup / rehearsal 実績 /
     Cloudflare write proven がすべて pass になることを確認。
4. Readiness all-pass 後に **「開始」(preparing → running)**。
5. 終了は **scheduledEndAt 到達で worker が自動 finalize**。急ぐ場合のみ
   Admin Web の即時 finalize (`POST /api/admin/contests/:id/finalize`) を
   使う。
6. `finalizing → finished` 遷移で archive Operation が自動 enqueue され、
   scoreboard JSON/CSV + DB snapshot artifact が生成される。**Archive**
   タブで DB snapshot を download し、off-host で SHA-256 を照合してから
   同タブに checksum を再入力して verified に上げる
   (`docs/superpowers/reviews/2026-08-13-contest-lifecycle-rollout.md`
   に off-host 検証結果を記録)。scoreboard JSON/CSV は公開経路のため
   `off_host_status` は `not_applicable` で、verify 操作は不要。
7. 後片付けは **順序が決まっている**。それぞれ前 gate を持つので、
   飛ばすと後段が blocked になる:

   | # | 操作 | 前 gate | 飛ばすとどうなるか |
   | --- | --- | --- | --- |
   | 7-1 | **Reconciliation** タブ → **診断** → 未 adopt の orphan があれば adopt をチェック → **adopt を反映した plan を取得** → **適用** | — | Cleanup が押せない (blocked の理由を表示)。Cleanup は常に `adoptHostnames: []` で plan を取り直すため、**Cleanup 側から orphan を adopt する経路は無い** |
   | 7-2 | **Cleanup** Operation (managed 外部 resource の撤収 + Instance を `deleted` に遷移)。7-1 の Operation 完了後に **Reconciliation** タブ → **診断** → Cleanup 欄の対象 hostname / VMID を確認 → 「影響を確認しました」→ **cleanup 実行**。対象 0 件なら「既に clean」と表示される | blocked entry が 0 件 | Return normal mode が `ResidualManagedResource` (409) で拒否される。また Instance が `deleted` に落ちないため、次回開催の readiness `previous_cleanup` が fail し続け **draft から `preparing` に上がれない** |
   | 7-3 | **Return normal mode** (benchvm 停止 → devvm 復帰)。**devvm を開発用途で使う期間に入るときだけ実施** (下記) | managed VM が Proxmox に残っていない | handler の `verify_no_managed_vms` で blocked |

   7-1 で adopt を要求されるのは「命名規約に合致する hostname の
   Cloudflare resource があるが、DB 側に対応する Instance / binding が
   無い」場合 (`unmanaged_orphan`)。portal が作ったものではない可能性が
   あるため、**明示 adopt なしには絶対に消さない**設計になっている。
   adopt する前に対象 hostname が本当に過去開催の残骸かを確認する。

   **7-3 は次回開催に必須ではない**。次回開催を `preparing` に上げる gate
   は readiness `previous_cleanup` (7-2 で満たされる) だけで、mode は
   見ない。devvm を当面使わないなら contest mode のまま置いておくのが
   手間が少ない。enter contest mode は contest mode からは 7 step すべてが
   「already」で何も変更せず通る。7-3 を実施した後に contest mode へ戻すのは、
   次回開催を preparing に上げてから Overview の **「競技モード切替」**
   (手順 3-2) で行う。finished / canceled の Contest からは起動できないので、
   それより前に戻すなら eevee 側で
   `../nixos-config-private/scripts/eevee-mode.sh contest` を使う。

   7-3 の memory_check は benchvm を停止した**後**に「node free ≥ devvm
   の割当 + reserve 1 GiB」を要求し、ZFS ARC (eevee では上限 4 GiB) を
   空きとして数えない。足りなければ blocked になり、その時点で benchvm
   は停止・onboot 0、devvm も停止・onboot 0 のまま止まる (8 step 中
   5 番目)。復旧は `docs/runbooks/contest-recovery.md` §6 (Insufficient
   RAM) に従う。devvm が既に running (通常モード中の押し直し) なら
   memory_check は空きを要求せずに通り、8 step すべてが何も変更せず
   succeeded で終わる (devvm の RAM は node free から既に引かれている)。

**古い制約 (第1回時点) は撤廃済み**: 「同じ DB で次回を開催するには pod を
止めて `portal.db` を消して seed し直す」「contest 行の status を SQL で
preparing に戻す」といった手順はもう不要。DB / 状態機械への直接介入は
リカバリ以外では行わない。

## block condition に落ちたとき

plan/apply、mode transition、finalization、cleanup が blocked / failed で
止まったとき、または資格情報を回すときは
**[`docs/runbooks/contest-recovery.md`](contest-recovery.md)** に従う。
通常フロー (この runbook) は Admin Web で完結する前提で書いてある。
