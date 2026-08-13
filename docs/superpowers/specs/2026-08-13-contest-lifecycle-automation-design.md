# INUCON 複数開催回・運営自動化設計

作成日: 2026-08-13 (JST)

## 概要

INUCON を第2回以降も反復開催できるよう、現行ポータルを複数開催回対応の運営
コントロールプレーンへ拡張する。開催履歴は同じ DB に保存し、ユーザーは開催回を
またいで再利用する。一方、チーム編成、インスタンス、ベンチジョブ、スコア、招待は
開催回ごとに分離する。

Admin Web から次の一連を操作できるようにする。

1. 前回開催のアーカイブと残存リソースの整合監査
2. 新しい開催回の作成、チーム編成、日程・台数の設定
3. 通常モードから競技モードへの切替
4. VM、Cloudflare 経路、Access 許可の準備
5. リハーサルと開催前診断
6. 手動開始、予定時刻での自動終了
7. 結果確定、外部アクセス失効、VM 撤収、通常モードへの復帰

外部操作はブラウザから直接 API を呼ばず、ポータル backend が配布済みの最小権限
credential を使って実行する。すべての操作を永続ジョブとして記録し、途中で pod や
外部 API が落ちても安全に再開できるようにする。

## 目的

- DB 削除や直接 SQL を使わず、第 n 回を Admin Web から作成・運営できる。
- 第1回を含む過去の結果を Web から閲覧できる。
- 開催回間でチーム、VM、ベンチ履歴、Access 許可が混ざらない。
- DB、Proxmox、Cloudflare の実体差分を検出し、適用前に変更内容を確認できる。
- Cloudflare と Proxmox の API を使い、定型操作を可能な限り自動化する。
- 自動化できない、または自動化すべきでない人間確認を runbook に限定して残す。
- 第2回の「1チーム・上限3台・約1週間」を、一般機構の設定値として表現する。

## 対象外

- `private-isu` 以外の問題テンプレートを Web 上で build すること
- 無制限のチーム数に応じて benchvm の NIC や NixOS network 設定を動的生成すること
- Cloudflare、GitHub、Proxmox の credential を Web から入力・表示・更新すること
- 開始時刻になっただけで競技モードへ切り替えたり、コンテストを自動開始したりすること
- 外部参加者本人による SSH 到達性や Access default-deny の最終確認を完全自動化すること
- 保存先が未設定の状態で off-host backup が存在するとみなすこと

問題テンプレートの新規 build と、現在2枠あるチームネットワークを超える容量拡張は
runbook に残す。既存 `tpl-private-isu` は再利用し、開催回には template VMID と問題の
revision を記録する。

## 2026-08-13 時点の現状監査

### リポジトリとポータル

- `develop` は clean で、作業中 PR はない。
- 本番 `https://inucon.kisen.one/api/health` は正常。
- 現行 DB は contest が1行だけで、状態は `finished`、quota は3。
- チームは2件、ユーザー2件、メンバー割当2件、pending invite は0件。
- ベンチジョブは finished 4件、failed 2件。
- 公開 scoreboard には第1回の結果が残っている。
- PVC には `portal.db` と WAL/SHM だけがあり、結果確定後の独立した DB snapshot はない。

### Proxmox

- 第1回の `inucon-team*` VM 実体はすべて削除済み。
- DB には `team1-1` が `running` のまま1件残っており、実体と不一致。
- `benchvm` は停止、`devvm` は12 GiBで稼働中。開催前に競技モード切替が必要。
- `team1` と `team2` bridge、各 subnet/NAT、全 `10.100.0.0/16` 間を drop する
  `inucon-team-isolation.service` は存在する。
- benchvm の guest network は team1/team2 の2枠だけを宣言している。したがって現行の
  自動開催機構が利用可能なチーム番号は、開催前診断で確認できた枠に限定する。

### Cloudflare

- `inucon-team1-1.kisen.one` と `inucon-team2-1.kisen.one` の DNS CNAME、Tunnel
  ingress、Access application が残っている。
- Proxmox に対応 VM がないため、いずれも第1回の孤児リソースである。
- ポータルには Cloudflare と Proxmox の API 設定が配布済みで、外部 API 自動化は有効。

### credential 管理

- ポータル credential は k3s Secret に存在するが、agenix が一貫した source of truth に
  なっていない。
- benchvm の remote-managed tunnel token と runner env は平文の mode 0600 ファイルで、
  `nixos-config-private` に開催前 agenix 化の申し送りが残っている。
- `cloudflared-inucon.age` は存在するが、現行 remote-managed tunnel の connector token
  配布を置き換えていない。

このため、第2回を作る前に「第1回の DB snapshot」「孤児リソースの reconciliation」
「credential 配布の統一」が必要である。個別の手作業で消すのではなく、本設計の最初の
実運用として行う。

## 採用アーキテクチャ

現行 portal の DDD 3層と Effect の port/layer 構成を維持する。

```text
Admin Web
  -> contest / operation HTTP API
    -> application use case
      -> contest/team/job repositories (SQLite)
      -> operation planner / worker
        -> ProxmoxPort
        -> CloudflarePort
        -> RunnerStatusPort
        -> BackupPort

Public Web
  -> contest archive / selected scoreboard API

nixos-config-private
  -> agenix secrets
  -> apphost: k3s Secret 同期
  -> benchvm: runner env / tunnel token
```

開催回の定義と外部操作を分離する。開催回を編集しただけではインフラを変更しない。
読み取り専用の plan API が desired state と observed state を比較し、その plan digest と
対象 revision を指定した apply API が運営ジョブを作る。ブラウザはジョブ状態を poll し、
backend worker が各 step を実行する。

運営ジョブは全体で同時1本にする。既存のインスタンス provisioner と競合しないよう、
競技モード変更、reconciliation、複数台準備、cleanup は同じグローバル operation lock の
下で動かす。ベンチジョブの直列制約とは別の lock とする。

## ドメインモデル

### Contest

Contest は次を持つ。

- `edition`: 正の整数、一意。第1回は1、第2回は2。
- `name`: 表示名。既定は `INUCON #<edition>`。
- `problemKey`
- `problemRevision`: 問題ソースの commit SHA または release 識別子。
- `templateVmid`
- `instanceQuota`: 1チームあたりの最大台数。
- `scheduledStartAt`
- `scheduledEndAt`
- `accessClosesAt`: 外部 SSH を失効させる時刻。既定は scheduledEndAt。
- `cleanupAt`: 自動 VM 撤収を明示 opt-in した場合だけ設定。既定は null。
- `startedAt` / `finalizingAt` / `finishedAt` / `canceledAt`
- `status`
- `revision`: plan/apply 間の optimistic concurrency 用。

状態機械は次の一方向遷移とする。

```text
draft -> preparing -> running -> finalizing -> finished
  |          |
  +----------+-> canceled
```

- `draft`: metadata と編成を編集できる。外部リソースは持たない。
- `preparing`: 競技モード、VM、経路、リハーサルを準備中。編成変更は再 plan が必要。
- `running`: 競技ベンチを受け付ける。
- `finalizing`: 新規 enqueue を止め、queued を cancel し、running 1件の完走または timeout を
  待って公式結果を確定する。
- `finished`: 結果が確定した読み取り専用アーカイブ。
- `canceled`: draft/preparing を中止したアーカイブ。残存リソースがあれば cleanup は継続する。

scheduledStartAt は案内と検証に使うが、自動 start には使わない。start は operator が診断結果を
確認して Web から明示実行する。scheduledEndAt を過ぎた running contest は worker が
finalizing へ進める。停止中だった場合は起動後の sweeper が同じ処理を1回だけ行う。

物理競技環境は1組なので、`preparing`、`running`、`finalizing` のいずれかにいる Contest は
全体で最大1件とする。draft は複数作成できる。

### User と開催回別チーム

User は GitHub identity と Access 用 email を持つグローバル entity として再利用する。
Team は Contest に属する entity に変更する。

- Team: `contestId`, `teamNumber`, `name`, `desiredInstanceCount`
- TeamMember: `contestId`, `teamId`, `userId`
- TeamInvite: `contestId`, `teamId`, `githubLogin`, `email`

同じ user は開催回ごとに別チームへ所属できるが、同一 Contest 内では最大1チームとする。
`teamNumber` は Contest 内で一意とし、開催回間では再利用できる。

新規開催ウィザードは前回のチームとメンバーを draft へコピーできる。コピーは convenience
機能であり、過去の Team 行を再利用・更新しない。

### Instance、BenchJob、Result

Instance と BenchJob は `contestId` と `teamId` の両方を持ち、DB constraint で同じ
Contest に属する組み合わせだけを許す。これにより URL や application code の誤りで別開催回の
VM やスコアを参照できないようにする。

BenchJob に `purpose = rehearsal | competition` を追加する。

- rehearsal は preparing 中に admin だけが enqueue できる。
- competition は running 中だけ参加チームが enqueue できる。
- rehearsal の結果は公式 scoreboard へ含めない。

finalizing 完了時に公式 scoreboard の JSON/CSV artifact と checksum を生成する。DB 上の
BenchJob は保持するが、公開アーカイブは確定 artifact と同じ計算条件を使う。

### Operation と ResourceBinding

外部変更は Operation と OperationStep に永続化する。

- Operation: contest、種類、actor、plan digest、status、開始/終了時刻、sanitized error
- OperationStep: 順序、step key、attempt、status、入力の非秘密要約、結果、時刻
- 種類: `reconcile`, `enter_contest_mode`, `prepare`, `start`, `finish`, `revoke_access`,
  `cleanup`, `return_normal_mode`, `backup`

ResourceBinding はポータルが所有する外部リソースを記録する。

- provider: `proxmox | cloudflare`
- type: VM、DNS record、Tunnel ingress、Access app/policy など
- contest/team/instance への owner reference
- canonical key: VMID や hostname
- external ID
- desired state / last observed state / last observed time

ポータル作成リソースだけを自動修復・自動削除する。legacy resource や binding のない resource は
reconciliation で `unmanaged orphan` として表示し、operator が対象を確認して adopt + cleanup
を明示したときだけ削除する。

## 運営ワークフロー

### 1. 前回の closeout

1. application-consistent な SQLite snapshot を作る。
2. scoreboard JSON/CSV と checksum を生成する。
3. Proxmox、Cloudflare、DB の inventory を読み取り、差分 plan を表示する。
4. 進行中ジョブ、実 VM、DNS、ingress、Access app、DB Instance 状態を照合する。
5. operator が plan を確認して cleanup を適用する。
6. `inucon-team*` の管理対象リソースが0件、かつ過去 Contest の Instance 行のうち `status != 'deleted'` のもの(running/creating/deleting/failed を含む。`failed` 行は vmid/IP を保持し続けるため次回開催の `vmidFor(teamNumber, index)` と衝突する)が0件であることを再監査する。

finished Contest とユーザー、チーム、ベンチ履歴は削除しない。

### 2. draft 作成

1. edition、表示名、problem/template revision、quota、開始・終了時刻を設定する。
2. 前回編成をコピーするか、新規チームを作る。
3. 各 Team の desiredInstanceCount を0からquotaの範囲で設定する。
4. 利用する teamNumber が benchvm と Proxmox の準備済み network slot に含まれるか確認する。
5. 日程、台数、推定 RAM、外部リソース数を確認して draft を保存する。

第2回はこの一般フォームに edition 2、team 1件、desiredInstanceCount 3、quota 3、約7日間を
入力する。値を第2回専用コードとして埋め込まない。

### 3. preparing と競技モード

`Prepare` はまず read-only preflight を行う。

- 前回 cleanup が完了している。
- apphost portal、k3s、PVC が正常。
- eevee、template VMID、必要 bridge/subnet、隔離 service が正常。
- desired RAM と現在の Proxmox node status `memory.free`(既存 ProxmoxPort が読む値。Linux `/proc/meminfo` の `MemAvailable` と違って reclaimable page cache を含まないため保守的側に倒している)に安全余白がある。
- devvm と benchvm の状態が取得できる。
- runner build/revision、benchmark directory、portal reachability が正常。
- Cloudflare tunnel が healthy で API inventory を取得できる。
- token permission が必要操作を満たす。

operator が競技モード切替を明示確認すると、devvm を guest shutdown し、停止完了と
`memory.free` を確認してから benchvm を起動する。force stop はしない。devvm が timeout した
場合は中断し、Web に復旧手順を出す。

### 4. インスタンスと外部経路の準備

Team ごとに desiredInstanceCount まで既存の idempotent provision saga を実行する。

1. VM clone/config/start
2. guest readiness
3. DNS CNAME
4. Tunnel ingress
5. Access app と、その開催回のメンバー email だけを含む allow policy
6. ResourceBinding の保存

複数台は1台ずつ作り、各台の後に `memory.free`(上述)と KSM の安定を再確認する。quota が3でも
容量診断を通らなければ3台目を無理に起動しない。第2回の3台構成は実機診断を通過することを
完了条件とし、物理メモリを根拠なく overcommit しない。

Access policy は過去開催の email との和集合にしない。ポータルが作成・所有する app は、現在の
Contest Team の正確な email 集合(= 現メンバーで email 登録済みのもの ∪ 当該 Contest の pending
`team_invites` の email。初ログイン前の招待者を締め出さないため union は Contest スコープ内で
維持する)へ収束させる。desired が空集合になる場合はポータル所有の allow policy を PUT せず、
ポリシー削除または deny-only の外殻に落として ResourceBinding にその状態を記録する(Cloudflare
は空 `include` を 400 で拒否するため)。未知の policy が同じ app に混在する場合は自動上書き
せず drift として停止する。

### 5. リハーサルと開始

preparing 中に admin が rehearsal job を実行する。開始可能条件は次のとおり。

- 全 desired Instance が running。
- Proxmox/Cloudflare reconciliation が clean。
- runner heartbeat が fresh。
- rehearsal が少なくとも1件成功。
- DB backup/export の書き込み先が利用可能。
- scheduledEndAt が現在より後。

operator が `Start` を明示確認すると running へ遷移する。scheduledStartAt は自動実行しないため、
準備遅延で意図せず競技が始まることはない。

### 6. 自動終了と結果確定

scheduledEndAt 到達時、または admin の即時終了で finalizing へ遷移する。

1. 新規 competition enqueue を拒否する。
2. queued job を cancel する。
3. running job は既存 timeout まで完走を待つ。終了前に enqueue 済みなら結果へ含める。
4. scoreboard artifact と checksum を確定する。
5. DB snapshot を作る。
6. `accessClosesAt` に達していれば scheduler は独立した `revoke_access` Operation を投入して外部 SSH 経路と Access app を撤収する(この Operation は finalize の step 列 `cancel_queued|wait_running|write_*|finish_contest` の一部ではなく、finish がグローバルロックを握っている間は解放されるまで tick ごとにリトライする — plan Task 12 Step 3 の一意性ガードを参照)。VM 撤収は cleanup Operation に分離する。
7. finished へ遷移する。

snapshot の off-host 保存先が未設定の場合、Admin Web は「server snapshot 済み / off-host copy
未完了」を区別して表示し、checksum 付き download を提供する。

### 7. cleanup と通常モード復帰

VM cleanup は結果確定と分離する。既定では operator が plan を確認して `Close resources` を
1回実行する。明示的に cleanupAt を設定した Contest だけ自動実行できる。

cleanup は各 Instance の VM、DNS、Tunnel ingress、Access app/policy を冪等に撤収し、
reconciliation が clean になってから DB 状態を確定する。すべての競技 VM が停止・削除済みなら
benchvm を正常停止し、`memory.free` を確認して devvm を起動する。

## Reconciliation

Reconciliation は provider inventory と DB の desired state を比較し、次に分類する。

- `in_sync`: desired と observed が一致。
- `missing`: DB/binding はあるが外部実体がない。
- `drifted`: hostname、IP、policy member、VM config 等が不一致。
- `managed_orphan`: binding はあるが owner が cleanup 済み。
- `unmanaged_orphan`: `inucon-team*` 命名だが binding がない。
- `ambiguous`: 重複 DNS、未知 policy、VMID/name 衝突など自動判断不能。

plan は作成・更新・削除を provider、resource type、canonical key 単位で列挙する。apply は
plan digest と Contest revision が現在値と一致するときだけ受け付ける。ambiguous は apply を
block し、runbook と対象 ID を表示する。

Cloudflare Tunnel ingress の catch-all と INUCON 以外の hostname は必ず保持する。
名前 prefix だけを根拠に自動削除しない。unmanaged orphan の削除には対象ごとの adopt 確認を
必要とする。

## Web UI

### 開催一覧

- edition、名前、状態、実開始/終了、チーム数を表示。
- current/upcoming を先頭にし、finished/canceled をアーカイブとして参照可能にする。
- public 側にも開催回 selector を追加し、各回の contest 情報と scoreboard を表示する。

### 開催詳細

- Overview: 状態、日程、問題 revision、quota、結果 artifact。
- Teams: 編成、desired/actual Instance、メンバー、招待。
- Readiness: portal、eevee、runner、Cloudflare、capacity、rehearsal の診断。
- Reconciliation: desired/observed diff と plan/apply。
- Operations: step、attempt、sanitized error、再試行可能性。
- Archive: scoreboard JSON/CSV、DB snapshot、checksum、off-host copy 状態。

### セットアップウィザード

1. Metadata
2. Schedule
3. Teams and members
4. Capacity and desired instances
5. Review and create draft

作成後の preparing は wizard に埋め込まず、開催詳細の checklist と operation として見せる。
ブラウザを閉じても backend job は継続する。

### 危険操作

競技モード切替、start、即時 finish、unmanaged orphan の adopt/delete、VM cleanup は、変更 plan と
影響対象を表示して明示確認を要求する。credential や生の API response は表示しない。

## API と worker

既存 API を current contest 固定から contest ID 指定へ拡張する。互換 route は current/upcoming
Contest を解決する薄い adapter とし、新 UI は明示 ID route を使う。

代表 endpoint は次の責務を持つ。

- contest list/detail/create/update/copy-roster
- contest-scoped teams/invites/instances/jobs/scoreboard
- operation plan/apply/detail/retry
- readiness snapshot
- reconciliation inventory/plan
- archive artifact download
- runner heartbeat と rehearsal job

worker は operation table から runnable step を1件 claim し、既存 provisioner と同様に status と
progress を保存する。pod restart 後は running のまま期限切れになった step を再評価し、外部実体を
GET してから継続する。外部 POST/PUT/DELETE を観測なしで盲目的に再送しない。

## エラー処理と再実行

- 各 step は idempotent な ensure/remove として実装する。
- 外部 API timeout は結果不明として inventory を再取得し、成功・未実行・ambiguous を判定する。
- retryable error は指数 backoff と上限回数を持つ。上限後は operator retry を待つ。
- validation、権限不足、resource conflict、ambiguous drift は自動 retry しない。
- cleanup は1 resource の失敗で残りを隠さず、可能な撤収を継続して最終的な差分を示す。
- token、Authorization header、Access email 一覧、OAuth secret、SSH key は operation log に残さない。
- actor、operation、plan digest、対象、結果、時刻は audit 用に保存する。

## credential と権限

`nixos-config-private` の agenix を secret の source of truth とする。

- apphost: portal env を age secret とし、NixOS の oneshot service が runtime で k3s Secret へ同期。
- benchvm: runner env と INUCON tunnel token を個別 age secret から EnvironmentFile として配布。
- secret plaintext を Nix store、Git、shell argv、operation log、Web response に載せない。
- token rotation は age secret 更新、host deploy、接続診断の順で runbook 化する。

Cloudflare token は対象 account/zone の Tunnel Edit、Access Apps/Policies Edit、DNS Edit、必要な
read 権限だけを持つ。Proxmox は team VM provision 用と mode power control 用を論理的に分け、
pool/VM ACL で対象を template、team VM range、benchvm、devvm に限定する。Admin browser は
いずれの token も受け取らない。

## 自動化せず runbook に残す操作

- 新しい問題の build、patch、template 化、benchmark 正当性確認
- team1/team2 を超える network slot の追加、benchvm NIC と NixOS network の拡張
- API token の初回発行、最小権限設定、失効、緊急 rotation
- 招待外 identity が Cloudflare Access で拒否されることの別アカウント実測
- 参加者端末からの SSH、ブラウザ認証、鍵認証の最終確認
- off-host backup destination が未設定の場合の snapshot download と外部保管
- ambiguous resource、未知 Access policy、VMID/name 衝突の人間判断
- graceful shutdown timeout 時の guest 内作業確認。force stop は自動化しない。

runbook は日常の正常系 command を並べるのではなく、Web が block した条件ごとの診断・復旧に
限定する。

## migration と第1回 cleanup

### DB migration

1. 現行 DB の application-consistent snapshot を取得し、ローカルへ保存して checksum を記録。
2. 第1回 Contest に `edition=1`、`templateVmid=9100`、
   `problemRevision=legacy-2026-07-08` を付与する。第1回 template は provenance 保存機能より
   前に構築されたため、未検証の commit SHA を推測せず、構築実施日を legacy 識別子として使う。
3. 既存 Team、TeamMember、Invite、Instance、BenchJob を第1回へ関連付ける。
4. TeamMember の global unique を contest-scoped unique へ移行。
5. 新 table/index/constraint を追加し、migration 前後の行数と relation 整合性を検証。
6. snapshot copy に対して migration dry-run を行ってから本番 deploy。

第1回の status、score、job、user、team は変更・削除しない。実体のない running Instance は
migration だけで deleted に書き換えず、reconciliation operation の監査記録を伴って解消する。

### 最初の reconciliation

現状から生成されるべき plan は次のとおり。

- DB の第1回 `team1-1` running 行: Proxmox VM missing として stale resource を cleanup。
- Cloudflare `team1-1`: DB resource と対応付けて撤収。
- Cloudflare `team2-1`: binding のない legacy orphan として表示し、operator 確認後に adopt + 撤収。
- Tunnel catch-all、portal hostname、INUCON 以外の DNS/Access: 変更なし。
- cleanup 後: `inucon-team*` VM/DNS/ingress/Access app が0、かつ過去 Contest の Instance 行のうち `status != 'deleted'` のもの(failed 含む)が0であることを確認する。plan Task 8 の `previous_cleanup` readiness と同じ predicate。

この clean gate を通るまで第2回を preparing にできない。

## テスト戦略

### Domain / repository

- Contest の全正常遷移と不正遷移。
- active Contest 最大1件、edition unique、schedule ordering。
- 同一 user の開催回別所属と、同一開催回内の重複所属拒否。
- Team/Instance/BenchJob の contest 不一致拒否。
- 第1回 fixture を使った migration、行数、score 不変、rollback。

### Application

- plan/apply の revision と digest 検証。
- prepare/start/finalize/cleanup の readiness gate。
- rehearsal が scoreboard に入らないこと。
- scheduled end、再起動後の overdue sweep、二重 finish 防止。
- running job drain、queued cancel、timeout。
- operation claim の直列化、step resume、retry、ambiguous stop。

### Provider adapter

- Proxmox inventory、mode switch、VM missing、shutdown timeout、RAM guard。
- Cloudflare exact policy、重複 DNS、unknown policy、catch-all 保持、legacy orphan。
- 2xx `success:false`、5xx、timeout 後の再観測。
- credential が error/log/response に含まれないこと。

### HTTP / Web

- admin 認可、contest ID isolation、archive public read。
- wizard validation、readiness、reconciliation diff、operation polling。
- 危険操作の stale plan 拒否と明示確認。
- edition selector で第1回と第2回の scoreboard が混ざらないこと。

### rollout と実開催での検証

1. 本番 DB snapshot と migration dry-run。
2. 第1回 archive の score/API/UI が移行前と一致。
3. first reconciliation plan を確認し、孤児撤収後に再監査 clean。
4. 第2回 draft を1チーム・desired 3台・約7日で作成。
5. 競技モード切替、3台の逐次 provision と capacity 実測。
6. 参加者 SSH、未許可 identity deny、rehearsal 成功。
7. operator が実日程を最終確認して第2回を start。
8. 実際の scheduled end で finalizing と結果確定を確認。終了時刻を短縮した本番テストで
   第2回を消費しない。時刻制御を伴う自動テストで scheduler の境界条件を先に検証する。
9. artifact/snapshot、access revoke、cleanup、通常モード復帰。

## 完了条件

- 第1回が Web archive として残り、既存 score が変わらない。
- 第1回の DB/Proxmox/Cloudflare 差分が reconciliation で clean になる。
- DB 削除や直接 SQL なしに第2回を作成できる。
- 1チーム・上限3台・約7日を Web で設定できる。
- start は明示操作、end は予定時刻で自動化される。
- 競技モード、VM、Cloudflare、rehearsal、cleanup の状態と履歴を Web で確認できる。
- worker/pod restart と外部 API 一時障害から安全に再開できる。
- API token が agenix 管理となり、Web/ログ/リポジトリへ平文露出しない。
- 自動化対象外が障害別 runbook にまとまり、正常開催で直接 DB/Cloudflare dashboard 操作を
  必要としない。
