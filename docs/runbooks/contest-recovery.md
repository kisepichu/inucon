# コンテスト運営 リカバリ runbook

対象: `docs/runbooks/contest-operations.md` の通常フロー(すべて Admin Web
から実行)が **block condition** に落ちたとき、または人手介入で復帰させる
必要があるときの手順のみを扱う。**通常運用の SQL 直叩きや dashboard 手直し
は含めない**(通常フローは Admin Web から実行し切る前提)。

各節は「症状 → 前提の確認 → 復旧手順 → 復帰確認」の順に書く。実操作の前に
必ず「前提の確認」で本当にそのブロックかを確定させる。

## 用語と共通操作

- **Admin Web**: https://inucon.kisen.one/admin 。復旧操作の第一選択。
- **Operation**: `portal` の永続 worker が実行する durable step 群。状態は
  `queued → running → succeeded|failed|blocked|canceled`。**global で
  同時 1 本**(SQLite の partial unique index が強制する)。
- **ResourceBinding**: portal が所有権を主張している外部 resource
  (Proxmox VM / Cloudflare DNS/Access/tunnel ingress) の台帳。
- **plan digest**: reconciliation plan の SHA-256。UI に表示されたものが
  apply 時の期待値。ずれていれば `StaleReconciliationPlan (409)`。

**ssh 先の役割**:
- `apphost.kisen.one` (192.0.2.20): portal pod / DB / backup PVC。
- `benchvm.kisen.one` (DHCP、`.5` / `.11` を実測): runner + cloudflared。
- `eevee` (192.0.2.10): Proxmox VE。SSH ではなく `pveum`/`qm` を
  介するのが基本(WebUI: https://192.0.2.10:8006)。

**secret 取り扱い**: 復旧手順に現れる token / API key / Cloudflare secret
/ Access 許可 email は絶対に journalctl・Operation log・PR コメント・
runbook 更新に貼らない。値は agenix (`../nixos-config-private/secrets/*.age`)
経由でのみ流す。

**参照: 実機の状態 (Task 14 実施済み)**:
- Proxmox pool: `inucon-team-vms` に template `9100` を格納。
- Proxmox 資格情報: `inucon-provision@pve`, `inucon-mode@pve` に
  `portal-2026-08-18a` サフィックスの API token を付与済み。
  旧 `portal@pve!inucon` は Step 7 完了確認まで温存(revoke は人手)。
- eevee のクローン先 storage は **`local-zfs`**(旧計画本文の
  `local-lvm` は誤記、Task 15 修正済み)。
- credential source of truth: `../nixos-config-private/secrets/`。apphost
  は `inucon-portal-env` / `inucon-proxmox-provision` / `inucon-proxmox-mode`
  を age から k3s Secret に sync、benchvm は `runner-env` /
  `inucon-tunnel-token` を age runtime EnvironmentFile として読む。

---

## 1. Stale plan (`StaleReconciliationPlan` 409)

**症状**: reconciliation apply が `StaleReconciliationPlan (409)` で
はじかれる。UI に表示している plan digest と backend が計算した digest が
一致しない。

**前提の確認**:
- 別の admin が直前に apply を走らせていないか (Contest → Operations
  タブで直近の reconciliation Operation)。
- Contest 側の `revision` / Team / Instance を更新した直後ではないか。

**復旧手順**: **Admin Web → Contest → Reconciliation タブで
「診断」を押す** だけ。新しい plan と digest が算出され、
再度 review → adopt hostname をチェック → 「adopt を反映した plan を取得」
→ apply。adopt 付き apply は adopt を反映して取り直した plan の digest で
しか通らない (digest は adoptHostnames と各 entry の action を含むので、
adopt なしの plan の digest は adopt 付き apply では必ず stale)。

**復帰確認**: apply Operation が enqueued 後 running → succeeded に
なること。Reconciliation タブが「差分なし」になること。

---

## 2. Ambiguous Cloudflare policy (`AmbiguousReconciliation` 422)

**症状**: reconciliation plan の一部 entry が `blocked` (typically
unmanaged_orphan の adopt 未確認、または CF Access policy が INUCON 用と
判別できない状態)。apply は 422 で拒否され、`hostnames` に対象が返る。

**前提の確認**:
- Admin Web の Reconciliation タブで entry を1件ずつ確認。`action` が
  `blocked` の理由を `summary` で読み取る。
- Cloudflare 側 (dash) に直接触った履歴があれば、その hostname が
  対象になっている可能性が高い。

**復旧手順**:
1. hostname が **確かに INUCON 所有** と特定できるなら、Reconciliation
   タブで対象 hostname に **adopt** を明示チェックし、「adopt を反映した
   plan を取得」で action が `adopt_cleanup` に変わったことを確認してから
   apply。これで `adopt_cleanup` action が走り、ResourceBinding を張ってから
   cleanup する。
2. hostname が INUCON 所有ではない (catch-all / 他サービス) なら、
   plan 側が `noop` になるはず。もし blocked のままなら Cloudflare 側で
   `inucon-` prefix でない tag に付け替える、または portal が触らない
   zone / account に切り替える。**catch-all と INUCON 以外の DNS/Access
   は絶対に触らない** (これは INUCON の設計不変条件、
   `docs/superpowers/plans/2026-08-13-contest-lifecycle-automation.md`
   Global Constraints 参照)。
3. 同一 hostname に他 admin が先に adopt をかけて apply したことによる
   `hostname_adopted_concurrently` blocked (usecases/reconciliation.ts
   478 行) の場合は **リロードして plan 再取得** で解決する。競合状態が
   仕様通り検知された結果なので upgrade path は不要。

**Cleanup Operation も同じ 422 を出す**。こちらは
`cleanupContestResources` / `scheduleContestCleanup` が常に
`adoptHostnames: []` で plan を取り直すため、**Cleanup 側から adopt する
経路は存在しない**。未 adopt の orphan がある間は Reconciliation タブの
Cleanup 欄の「cleanup 実行」は押せない (blocked の hostname を表示する) ので、
先に上記 1 の手順で Reconciliation タブから adopt +
apply を済ませる。順序は
`docs/runbooks/contest-operations.md` の「次回開催を作る」§7 の表に従う。

**復帰確認**: Reconciliation タブで対象 hostname が一覧から消える。
apply Operation が succeeded。Cloudflare 側 dashboard で app / DNS が
消えていることを目視確認 (dash 変更は一切しないこと)。

---

## 3. Duplicate DNS record

**症状**: Cloudflare に `inucon-teamN-M.kisen.one` の DNS record が **2 件
以上** 存在する。plan 側は「1 件」を仮定するため cleanup / adopt_cleanup
のいずれでも一貫した結果にならない。

**前提の確認**:
- Cloudflare API から件数を確認 (dashboard から編集しない):
  ```sh
  # ${CF_ZONE_ID}/${CF_API_TOKEN} は k3s Secret 側にしか無い。ここでは
  # 「portal pod 内から」実行する (値をシェル変数へ出さない)。
  ssh apphost.kisen.one "kubectl -n inucon exec deploy/inucon-portal -- \
    node -e 'const zone=process.env.CF_ZONE_ID; \
      fetch(\"https://api.cloudflare.com/client/v4/zones/\"+zone+ \
        \"/dns_records?name=inucon-teamN-M.kisen.one\", \
        { headers:{ authorization:\"Bearer \"+process.env.CF_API_TOKEN } }) \
      .then(r=>r.json()).then(j=>console.log(j.result.length))'"
  ```

**復旧手順**:
1. 通常は Reconciliation の adopt を通すと `cleanup` step が全 record を
   まとめて掃除する (adapter は同一 name の全 record を対象にする)。
   まず **adopt 経由の apply を1回試す**。
2. それでも残るときのみ、`portal pod` から Cloudflare API で該当 record
   の id を列挙し、`DELETE` で1件ずつ削除する。**dashboard は触らない**。
   値を journalctl や PR コメントに残さないこと。
3. 削除後に Reconciliation を Refresh。plan が「差分なし」または
   `noop` に落ちることを確認。

**復帰確認**: 上のカウントスニペットが `0` (対象 team を撤収した後) また
は `1` (対象 team を運用中) を返す。

---

## 4. Missing VM

**症状**: 台帳 (Instance / ResourceBinding) に存在するのに Proxmox
から VM が消えている (手動で削除された等)。プロビジョニング / cleanup
が「対象 VM が無い」で失敗する。

**前提の確認**:
- eevee 側で `qm list` に該当 VMID (`1000 + teamNumber*100 + slot`) が
  無いこと。
- portal の該当 Instance status が `creating` / `running` / `deleting`
  のどれか。

**復旧手順**:
1. Reconciliation を Refresh。台帳に有って observed に無い entry は
   `cleanup` として plan に載る (VM は既に無いので Proxmox 側は no-op、
   Cloudflare 側の DNS/Access のみ掃除される)。
2. apply して該当 Instance を **portal 上で削除状態に持っていく**
   (compensating saga が ResourceBinding / DNS / Access を最終的に外す)。
3. 同じ team が再度 VM を欲しいなら、通常フロー通り Team ページから
   「インスタンス追加」で新規払い出し。**DB / 台帳を SQL で書き換えて
   復活させない**。

**復帰確認**: Reconciliation Refresh 後に該当 entry が消える。Team ページ
の Instance 一覧に該当 slot が無い、または `running` の新 VM が居る。

---

## 5. Shutdown timeout (mode transition)

**症状**: `enter_contest_mode` / `return_normal_mode` Operation の
`wait_devvm_stopped` step が `blocked` に落ち、summary に
`"devvm guest shutdown did not complete within <ms>ms; verify guest
agent then run 'qm shutdown 9300' manually (do not force stop)"` が
出ている (`portal/src/application/usecases/modeOperation.ts` 102-107 行)。

**VMID mapping (実機 `qm list` 実測、2026-09-22)**: **9300 = devvm**
(開発サーバ、memory 12288 MiB、onboot 1)、**9200 = benchvm** (bench
runner VM、memory 4096 MiB、onboot 0)。`../nixos-config-private/scripts/eevee-mode.sh`
の名前検証と一致する。**取り違えると「devvm を止めるつもりで bench
runner を止める」**。portal 側は power 操作の前に observed name を
突き合わせ、不一致なら `VMID mapping mismatch: VM <vmid> is named
'<observed>', expected '<expected>'; ...` で **blocked** に落ちる
(`portal/src/domain/modeVmIds.ts` の fail-closed ガード)。この summary が
出たときは VM を触らず、Proxmox 側の `/vms` mapping と VM 名を先に直す。

**前提の確認**:
- eevee: `qm status 9300` で `status: running` のまま止まっているか。
- devvm 内: `qm guest cmd 9300 ping` が応答するか (guest agent の
  生死確認。応答が無ければ guest agent 側の障害)。

**復旧手順**:
1. devvm にログインできる (SSH or console) なら中で `sudo systemctl
   poweroff` を実行。
2. できないなら eevee で **`qm shutdown 9300`** をもう一度発行
   (guest ACPI shutdown。`qm stop` は絶対に使わない — force stop 禁止
   は `application/ports.ts` 481 行と設計制約)。
3. `qm status 9300` が `stopped` になったら Admin Web → Operations
   タブから対象 Operation を **cancel** (下記 §12 「Operation cancel の
   一般手順」)。**cancel だけでは再開しない**: `contestScheduler` の
   tick は `tickFinalize` / `tickRevokeAccess` / `tickCleanup` の 3 種
   しか無く (`portal/src/infrastructure/worker/contestScheduler.ts`)、
   `enter_contest_mode` / `return_normal_mode` を自動 re-enqueue する
   経路は無い。cancel 後に **Admin Web から改めて enter_contest_mode
   (または return_normal_mode) をリクエスト** する。devvm は既に
   stopped なので `wait_devvm_stopped` は即成功し、`memory_check`
   から自然に継続する (`portal/src/application/usecases/modeOperation.ts`
   93-96 行)。

**手で mode 遷移を通す場合**: 単発の `qm start` / `qm shutdown` を並べる
のではなく **`../nixos-config-private/scripts/eevee-mode.sh
{status|normal|contest}`** を使う。script 側が portal と同じ安全弁を
実装している:
- **名前検証 (fail closed)**: `qm list` の name で devvm=9300 /
  benchvm=9200 を裏取りし、1 件でもズレたら何もせず exit 1。
- **memory guard**: 起動する VM の `memory + 1024 MiB host reserve` を
  `MemAvailable` と比較し、足りなければ起動しない (graceful shutdown 後に
  スナップショットを取り直し、同一 run 内の累積コミット分も差し引く)。
- **graceful shutdown 待ち・force stop 禁止**: `qm shutdown` の完了を
  ポーリングで待ち、`qm stop` は一切発行しない。

**ssh 経路の注意**: `apphost.kisen.one` は Cloudflare tunnel 経由なので
ProxyJump に使うと `Bad packet length` で壊れる。LAN 内から実行するなら
`EEVEE_SSH_JUMP=none`、jump が必要なら
`EEVEE_SSH_JUMP=kise@192.0.2.20` を指定する。

**復帰確認**: Operation が succeeded、または改めて enqueue した
Operation が succeeded で終わり、`benchvm (9200)` が `running` になる
(mode transition の最終 step)。

---

## 6. Insufficient RAM

**症状**:
- Instance 払い出し時: `InsufficientMemory` (`freeBytes` <
  `minFreeMemBytes`)。API/UI に `409` 相当のエラー。
- mode transition 中: `enter_contest_mode` の `memory_check` step が
  `blocked` に落ち、summary に `post-shutdown MemAvailable <B> <
  benchvm(<B>) + reserve(<B>); check other workloads on the node before
  retrying` が出る (`modeOperation.ts` 118-121 行)。

**前提の確認**:
- eevee 側 `pvesh get /nodes/eevee/status --output-format json`
  (WebUI でも可) の `memory.free` を確認。KSM 統合待ちの直後は数分で
  下がるため、5-10 分の再試行余地がある。
- 他 workload (講評 VM、開発 VM 等) が eevee で走っていないか。

**復旧手順**:
1. 明らかに 5-10 分待てば KSM で下がる状況なら、Admin Web で該当
   Operation を **cancel** し、5-10 分後に再度 apply / start / mode
   遷移をリクエスト。
2. 他 workload が原因なら、それらを別ノード or 停止に回してから再試行。
3. 恒久的に足りないなら quota / desiredInstanceCount を下げる
   (Contest 設定変更 → Reconciliation Refresh → apply)。

**復帰確認**: 再試行 Operation が succeeded。

---

## 7. Stale runner (heartbeat 期限切れ)

**症状**: Readiness チェックが `runner: fail — no runner heartbeat
within <maxAgeMillis>ms` (`portal/src/application/usecases/readiness.ts`
387 行)。start / rehearsal が gate される。ベンチ enqueue は形式上
可能でも runner が拾わない。

**前提の確認**:
- benchvm: `systemctl status inucon-runner` が active か。
- benchvm: `journalctl -u inucon-runner --since '5 min ago'` に
  `poll` の痕跡があるか。
- benchvm の IP: apphost から
  `ssh root@192.0.2.10 'qm guest cmd 9200 network-get-interfaces'`
  で現在 IP を確認 (DHCP 変動)。

**復旧手順**:
1. runner unit が inactive: `sudo systemctl restart inucon-runner`。
   起動しないなら `journalctl -u inucon-runner --since '5 min ago'` で
   原因確認 (agenix runtime path の EnvironmentFile が存在しない、等)。
2. token 不整合 (401 が並ぶ): §11 「Credential rotation」に進む。
3. benchvm 自体に到達できない: eevee で `qm status 9200`。stopped なら
   `../nixos-config-private/scripts/eevee-mode.sh contest` で起動する
   (単発 `qm start 9200` は memory guard と名前検証を飛ばすので使わない。
   §5 「手で mode 遷移を通す場合」参照)。
4. cloudflared が落ちていて portal 側から到達できないだけならベンチは
   動く (runner→portal は LAN NodePort:30080 直結)。tunnel 復旧は
   `docs/runbooks/apphost-cloudflared.md` (private repo 側 runbook)。

**復帰確認**: Readiness チェックの `runner` が `pass`。ベンチを1本
enqueue し `finished` まで通ることを Team ページで確認。

---

## 8. Backup unavailable (backup PVC not writable)

**症状**: Readiness `backup: fail`、または finalization Operation の
`snapshot_db` step が失敗 (`reason: not_writable`,
`portal/src/infrastructure/backup/sqlite.ts` 90-200 行付近)。

**前提の確認**:
- apphost: `kubectl -n inucon get pvc inucon-portal-backups` が Bound。
- pod 内: `kubectl -n inucon exec deploy/inucon-portal -- ls -la /backups`
  が 200 以外なら mount 未確立。
- disk full: `kubectl -n inucon exec deploy/inucon-portal -- df -h /backups`。

**復旧手順**:
1. PVC が Pending: `deploy/k8s/backup-pvc.yaml` の storage class / size を
   確認、または PV を手当てして apply。
2. mount 未確立: `kubectl -n inucon rollout restart deployment/inucon-portal`
   → `rollout status` を待つ。
3. disk full: 古い snapshot / artifact を pod 内から確認し、**保管が
   終わっているもの (§8 rollout report で off-host 確認済み)** のみ削除。
   まだ off-host 確認していないものは残す。
4. どれでも直らないなら finalization を待たず、`deploy/README.md` の
   手動 online backup 手順で off-host に取り出す (Admin Web は使わずに
   raw DB を保存)。

**復帰確認**: Readiness `backup: pass`。次回 finalization Operation の
`snapshot_db` が succeeded になり、Artifact のダウンロード + verify が
通ること。

---

## 9. Failed cleanup (cleanup Operation が failed / blocked)

**症状**: `scheduleContestCleanup` または Admin Web (Reconciliation タブの
Cleanup 欄) から enqueue された cleanup Operation が terminal で `failed`
または `blocked`。Reconciliation タブで差分が残る。

**前提の確認**:
- Admin Web → OperationDetail で失敗 step / sanitizedError を確認。
- Cloudflare 側の一時故障 (`ProviderUnavailable`) と、`blocked`
  (adopt 未確認) と、`hostname_adopted_concurrently` を区別する。

**復旧手順**:
1. **ProviderUnavailable / retry 中**: 自動 retry (exponential backoff、
   `operationWorker.ts` 86-96 行) が回っているので、しばらく待つ。
   `attempt` が `maxAttempts` に達したら次項へ。
2. **`blocked` (operator 判断待ち)**:
   - adopt 未確認 → §2 「Ambiguous Cloudflare policy」に従い adopt 指定
     を追加。cleanup Operation は cancel してから Reconciliation を
     再 apply し、完了後に「診断」→ Cleanup 欄から cleanup を再実行。
   - `hostname_adopted_concurrently` → plan 再取得。
   - shutdown timeout → §5。
3. **`failed`**: 一度 cancel し、Reconciliation タブで「診断」→ 差分と
   Cleanup 欄の対象 hostname / VMID を確認してから「cleanup 実行」で
   投入し直す (idempotent。DB 側の ResourceBinding は残るので二重実行
   しても外部側の作業は増えない)。

**復帰確認**: 再投入した Operation が succeeded、Reconciliation 差分が
消える。§10 「Post-cleanup 状態の検証」を実施 (rollout Step 10 相当)。

---

## 10. Migration rollback (schema change を戻す必要が出た)

**前提**: SQLite migration は forward-only。**戻す = pre-migration
snapshot からの復元** のみ。

**症状**: 新 image のデプロイ後、start-up でマイグレーションが失敗
(pod が CrashLoop)、または起動後の観測で不整合が判明。

**復旧手順** (rollout Step 4 の off-host snapshot が **必ず** ある
前提):
1. apphost 側で pod をゼロにする:
   ```sh
   ssh apphost.kisen.one 'kubectl -n inucon scale deploy/inucon-portal --replicas=0'
   ```
2. 手元 (WSL) の `~/backups/inucon/portal-before-multi-contest-<UTC>.db`
   の SHA-256 を off-host verify 記録と照合。
3. apphost の DB PVC に snapshot を書き戻す (pod 停止済み。ここで
   同時アクセスが無いことを再確認)。`kubectl run --rm` は container 終了
   と同時に pod を消すので、**WAL/SHM 削除は同じ container command に
   畳み込む** (別 pod で `exec` すると pod not found で失敗し、WAL が
   復元後の DB に replay されてロールバックが黙って上書きされる):
   ```sh
   scp ~/backups/inucon/portal-before-multi-contest-<UTC>.db \
     apphost.kisen.one:/tmp/portal-restore.db
   # kubectl run が非ゼロで終わっても /tmp/portal-restore.db は必ず消す
   # (全開催回の score / user / team を含む生 DB なので apphost shell 権限
   # 者へ露出させない)。trap EXIT で kubectl 成否と独立に rm を発火。
   ssh apphost.kisen.one "
     trap 'rm -f /tmp/portal-restore.db' EXIT
     kubectl -n inucon run restore --rm -i --restart=Never \
       --image=busybox --overrides='{\"spec\":{\"volumes\":[{\"name\":\"data\",\"persistentVolumeClaim\":{\"claimName\":\"inucon-portal-data\"}}],\"containers\":[{\"name\":\"restore\",\"image\":\"busybox\",\"stdin\":true,\"stdinOnce\":true,\"volumeMounts\":[{\"name\":\"data\",\"mountPath\":\"/data\"}],\"command\":[\"sh\",\"-c\",\"cat > /data/portal.db && rm -f /data/portal.db-wal /data/portal.db-shm\"]}]}}' < /tmp/portal-restore.db
   "
   ```
   busybox の `run --rm -i` に stdin を流し込む形。DB PVC を書き換える
   唯一の経路。もし WAL/SHM 消し込みを忘れて別 pod を作る形にすると、
   pod 起動 → 旧 WAL の replay → 復元した DB に上書き、で snapshot が
   静かに壊れるので **絶対に単一 container command に畳む**。
4. **旧 image に image tag を戻す**。`deploy/README.md` の「ロール
   バック」節に沿って、問題コミットを revert した main コミットの image
   を build / import / rollout する。migration は前バージョンに戻る。
5. `kubectl -n inucon scale deploy/inucon-portal --replicas=1` で再開、
   `/api/health` 200 と `sqlite3 :memory: 'PRAGMA integrity_check'`
   相当の起動時 verify (pod ログ) を確認。

**復帰確認**: portal healthy、public scoreboard の score / job 数が
snapshot 時点と一致 (edition1 のスコア: 1077 / 910 が rollout Step 8
基準)。復旧後は原因調査を進め、次の forward migration で解決する
(戻すのは復旧の最終手段)。

---

## 11. Credential rotation

**対象と経路** (Task 14 で確立した source of truth):

| Secret | age file | 消費者 |
| --- | --- | --- |
| `GITHUB_CLIENT_ID/SECRET`, `ADMIN_GITHUB_LOGINS`, `RUNNER_TOKEN`, `BASE_URL` | `secrets/inucon-portal-env.age` | apphost k3s Secret `inucon-portal-env` |
| Proxmox provision token (`inucon-provision@pve!portal-<suffix>`) | `secrets/inucon-proxmox-provision.age` | apphost k3s Secret (同じ Secret に merge) |
| Proxmox mode token (`inucon-mode@pve!portal-<suffix>`) | `secrets/inucon-proxmox-mode.age` | apphost k3s Secret (同じ Secret に merge) |
| Runner env (`RUNNER_TOKEN` を含む) | `secrets/runner-env.age` | benchvm `inucon-runner` EnvironmentFile |
| Cloudflare tunnel connector token | `secrets/inucon-tunnel-token.age` | benchvm `cloudflared-inucon` EnvironmentFile |

**復旧手順 (共通)**:
1. `../nixos-config-private` で age ファイルを再生成 (Task 14 Step 4-6
   のスクリプト。値はシェル変数に出さず pipe で age に流す)。
2. `nix flake check`、`nix eval --json` で runtime path のみが serialize
   されることを確認 (Task 14 Step 8)。
3. 該当ホストで **人手** で `sudo nixos-rebuild switch --flake ...`。
   本 runbook からは実行しない。
4. apphost (portal 側): k3s Secret sync は systemd oneshot が自動、
   `kubectl -n inucon get secret inucon-portal-env -o jsonpath='{.data}'|
   jq keys` でキー名のみ確認 (値を出さない)。portal を
   `rollout restart` で再読み込み。
5. benchvm (runner / cloudflared): `systemctl restart inucon-runner`、
   `systemctl restart cloudflared-inucon`。`journalctl -u <unit>
   --since '1 min ago'` に値が現れないこと。

**Proxmox token 個別注意**:
- provision と mode は必ず **別 user・別 token**(`inucon-provision@pve` /
  `inucon-mode@pve`)。1 個の token に統合しない (least-privilege 分割は
  Task 14 の設計不変条件)。
- token suffix を必ず一意なもの (`portal-YYYY-MM-DDx`) にして生成、旧 token
  は Step 7-verify が終わってから **人手** で
  `pveum user token remove <user> <suffix>` で削除する (自動化しない)。
- 旧 `portal@pve!inucon` (Task 14 前の統合 token) は Task 15 Step 7 完了
  まで温存。revoke は本 runbook 対象外 (人手)。

**復帰確認**: 該当 Operation を1本 (read-only inventory refresh 等) 走
らせて 200 系で終わる。Cloudflare tunnel については benchvm
`journalctl -u cloudflared-inucon` に `Registered tunnel connection` が
出ること。

---

## 12. Contest stuck in `finalizing` (blocked Operation が global lock を掴んだまま)

**症状**: Contest 状態が `finalizing` から進まない。ContestAdmin の
Operations タブに 1 本の Operation が `blocked` で残っている。scheduler
は「global で単一 unfinished」制約 (`operations` の partial unique index
`idx_operations_single_unfinished`,
`portal/src/infrastructure/sql/migrations/0006_operations.ts` 49-50 行)
のため次の `finish` Operation を enqueue できず、待ち続ける。

**前提の確認**:
- Admin Web → ContestAdmin → Operations タブで **blocked が 1 本、
  それ以外に unfinished が無い** ことを確認。
- 対象 Operation の OperationDetail で失敗 step と summary を読む。
  復旧不能な blocking かどうかを判断する (§2 / §5 / §6 / §9 のどれか)。

**復旧手順**:
1. まず OperationDetail の指示に従って **物理条件を直す**
   (shutdown timeout なら §5、memory なら §6、CF ambiguous なら §2)。
2. Operation を **cancel** する。canonical な経路は Admin Web
   だが、Task 15 時点で cancel UI 未実装 (`shared/src/api.ts` に cancel
   endpoint 無し、`OperationDetail.tsx` にもボタン無し) のため、当面は
   **portal pod 内から SQL 直叩き** で対象 Operation を canceled 化する。
   `OperationRepo.cancel` (`portal/src/infrastructure/sql/repos/operationRepo.ts`
   623-691 行) が実際にやっているのは以下 3 段: (a) running な
   `operation_steps` 行が無いことの pre-check、(b) `operations` を
   `canceled` に UPDATE、(c) 残っている `queued` step を `failed` +
   `sanitized_error='{"code":"canceled",...}'` に落として terminal 化
   (queued step を残すと `listSteps` の UI が「実行可能に見えるが絶対に
   実行されない」ゴミ行を返し続ける)。同じ 3 段を SQL でそのまま再現する:
   ```sh
   # 対象 Operation の id は Admin Web の OperationDetail URL から取得。
   # NOW=<現在 epoch ms>。復旧目的の 1 回限りの介入で、通常フローには
   # 現れない (通常フローは Admin Web から実行し切る)。
   # $OP は shell 展開で SQL 文字列に埋め込む。paste 事故で余計な '
   # や ; が入るとステートメント境界が崩れうる。実行前に UUID 形式
   # (`crypto.randomUUID()` の v4 出力、例: 0193e5a8-9c1d-4abc-8f01-23456789abcd)
   # であることを目視確認し、以下の正規表現でも一度弾いておく:
   OP=<opId>
   NOW=$(node -e 'console.log(Date.now())')
   printf '%s\n' "$OP" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' \
     || { echo "OP is not a UUID: $OP" >&2; return 1 2>/dev/null || exit 1; }

   # (a) running step が残っていないことを先に確認 (残っていたら abort。
   #     外部 mutation の結果を失うため、operator が先に片付けるべき)。
   #     ただしこの SELECT と後段の UPDATE の間に別トランザクションが状態
   #     を書き換える TOCTOU は残るため、後段の UPDATE 側も条件で守る
   #     (別 admin の Retry で running に戻った場合に queued step だけ
   #     canceled 化して operation は running のまま、という壊れ方を防ぐ)。
   ssh apphost.kisen.one "kubectl -n inucon exec deploy/inucon-portal -- \
     sqlite3 /data/portal.db \
       \"SELECT id, status FROM operation_steps \
          WHERE operation_id='$OP' AND status='running';\""
   # → 0 行を確認。1 行でも返ったら SQL 実行を中止し §5 / §9 に戻る。

   # (b)+(c) を単一 sqlite3 セッションでトランザクションにまとめる。
   #        - operations 側の WHERE は `OperationRepo.cancel` と同じ集合
   #          で、in-flight な `running` は絶対に触らない。
   #        - operation_steps 側は「operations が canceled になっていれば
   #          そのときのみ queued を canceled 化」というサブクエリガード
   #          で TOCTOU を閉じる。operations UPDATE が 0 行だと subquery
   #          は前状態を返し (`running` / `succeeded` / `canceled` 以外)、
   #          steps UPDATE も 0 行 no-op に落ちる。この形が
   #          `OperationRepo.cancel` (operationRepo.ts:623-691) の
   #          「単一 tx 内で running check + operations UPDATE + steps
   #          UPDATE」atomicity と等価。
   ssh apphost.kisen.one "kubectl -n inucon exec -i deploy/inucon-portal -- \
     sqlite3 /data/portal.db <<'SQL'
   BEGIN IMMEDIATE;
   UPDATE operations
     SET status='canceled', finished_at=$NOW
     WHERE id='$OP' AND status IN ('queued','failed','blocked');
   UPDATE operation_steps
     SET status='failed', finished_at=$NOW,
         sanitized_error='{\"code\":\"canceled\",\"summary\":\"operation was canceled before this step ran\",\"details\":{}}'
     WHERE operation_id='$OP' AND status='queued'
       AND (SELECT status FROM operations WHERE id='$OP') = 'canceled';
   COMMIT;
   SELECT id, status, finished_at FROM operations WHERE id='$OP';
   SELECT ordinal, status FROM operation_steps WHERE operation_id='$OP' ORDER BY ordinal;
   SQL"
   ```
   復帰確認は上の SELECT が `operations.status='canceled'` と、`operation_steps`
   に `queued` が **1 件も残っていない** ことを示すこと。もし `operations`
   側の UPDATE が 0 行だった (= `status` が既に `succeeded` / `canceled` /
   `running`) 場合は operation_steps 側も subquery guard で 0 行になり
   状態が壊れない。もし SELECT が `running` を返したなら状況が変わって
   いるので触らず OperationDetail を読み直す。
3. cancel が成立すると `idx_operations_single_unfinished` が空になり、
   `contestScheduler` の次 tick で `tickFinalize` (`contestScheduler.ts`
   70-108 行) が `finish` Operation を enqueue する。tick 周期内 (数十秒)
   で自動復帰する。

**復帰確認**: Contest 状態が `finalizing → finished` に遷移。Operations
タブの一覧に新規 `finish` Operation が `succeeded` で載る。Archive
Operation が enqueue され scoreboard JSON/CSV + DB snapshot artifact が
生成される。§8 rollout report で SHA-256 を off-host verify。

---

## Task 15 rollout で人手が担う (自動化しない) 工程

以下は本 runbook を持って作業する human operator が担当する。sub-agent /
CI が触ってはならない。Task 15 Step 4-11 の実施 log は
`docs/superpowers/reviews/2026-08-13-contest-lifecycle-rollout.md` に
埋める。

- apphost / benchvm 上での `sudo nixos-rebuild switch`。
- 旧 `/home/kise/.inucon/runner-env` 等の平文 EnvironmentFile 削除。
- 旧 `portal@pve!inucon` API token (Task 14 前の統合 token) の
  `pveum user token remove` による revoke。
- WSL 上での pre-migration snapshot 作成 (rollout Step 4)。
- dry-run migration の突合 (rollout Step 5)。
- develop → main PR の merge、`nixos-config-private` credential branch
  の merge、image import、初回 rollout (rollout Step 6-7)。
- edition1 の archive 突合 (rollout Step 8)、reconciliation 承認
  (Step 9-10)、edition2 draft 作成 (Step 11)。

sub-agent の担当範囲 (Task 15 Step 1-3, 12) は README 冒頭と PR 本文に
明記する。

---

## 参考

- 状態機械: `portal/src/domain/{contest,operation,reconciliation}.ts`
- API 契約: `shared/src/api.ts`
- 通常フロー runbook: `docs/runbooks/contest-operations.md`
- デプロイ runbook: `deploy/README.md`
- Task 14 (agenix source of truth) 実装計画:
  `docs/superpowers/plans/2026-08-13-contest-lifecycle-automation.md`
- rollout report (Task 15 Step 12):
  `docs/superpowers/reviews/2026-08-13-contest-lifecycle-rollout.md`
