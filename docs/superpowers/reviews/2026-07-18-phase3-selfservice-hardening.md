# Phase 3 セルフサービス レビュー指摘と対応方針(2026-07-18)

ローカル codex(`codex exec review --base develop`)がブランチ全体(Task 4/5 の
backend 含む)に対して出した指摘。UI リスタイル(Task 6, commit 3f06795)とは
別範囲。妥当性は実コードで確認済み。

## #1 self-service の index が無制限 → vmid/IP 衝突【真のバグ・対応する】

- `portal/src/application/usecases/instances.ts` `requestCreateInstance` は
  リクエストの `index`(`CreateTeamInstanceRequest`、positive のみ検証)を無検証で
  `newInstance` → `vmidFor`/`ipFor` に渡す。
- ドメイン不変条件 `vmid = 1000 + teamNumber*100 + index` は **index < 100** 前提で
  のみチーム間で一意。`ipFor = 10.100.<tn>.1<index>` は index≥100 で不正 IP。
  - 例: team1・index=101 → vmid 1201 = team2・index=1 の vmid。IP は
    `10.100.1.1101`(不正)。
- 直叩きで即到達。UI の `nextInstanceIndex`(active の max+1)も削除→再追加の
  繰り返しで単調増加するため通常操作でも到達し得る。
- self-service 経路は admin 経路(`createInstance`)と違い `ipFor` 結果を
  `validateBenchTarget` していない。

**対応**: index をサーバー採番にする。`requestCreateInstance` が当該チームの
active(creating/running)でないもっとも小さい `1..instanceQuota` の空きスロットを
割り当てる。`CreateTeamInstanceRequest` から `index` を除去し、UI は index を
送らない(`nextInstanceIndex` 撤廃)。これで index ≤ quota が保証され vmid/IP 不変
条件が常に成立。原子性は既存の `createIfAllowed`(quota+進行中を原子的に再検証、
進行中1本ガードで同時追加は直列化)に委ねる。

## #2 コンテスト未 running でも API で追加できる【仕様通り・UI 側を修正】

- `requestCreateInstance` は contest を取得するだけで `status === "running"` を
  検証しない。UI(Team ページ)だけが add ボタンを running でガード。
- **決定(ユーザー確認済み)**: admin が事前にインスタンスを払い出す想定 → API が
  running を要求しないのが正。**UI の add ボタンから「コンテスト未開催」ガードを
  外す**(quota・進行中ガードは維持)。bench 実行フォームの running ガードは維持。

## #3 running 以外のインスタンスにベンチを投げられる【バグ(軽)・対応する】

- `portal/src/application/usecases/bench.ts` `enqueueBenchJob` は instanceId →
  privateIp 解決 + チーム所属照合のみで `instance.status` を見ない。
- UI の bench select は全 status(creating/deleting/deleted/failed 含む)を表示。
- deleted/failed VM へ enqueue でき、接続失敗でジョブ枠を浪費。

**対応**: UI の bench select を `running` のみに絞る(running が無ければ実行不可の
理由を表示)。backend の `enqueueBenchJob` で instanceId 指定時に
`status !== "running"` を拒否する明示エラー(例 `InstanceNotRunning`)を追加。

## #4 self-service 削除がチーム全体の進行中1本ガードを見ていない【バグ(軽)・対応する】

- スペック §Instance 集約 不変条件2(チームにつき進行中の creating/deleting は
  高々1件)は `requestCreateInstance` 側では `ProvisionInProgress` で担保して
  いる(`existing` から creating/deleting の有無を見て弾く)。
- `portal/src/application/usecases/instances.ts` `requestDeleteInstance` は
  削除対象インスタンス自身の状態(running/failed か)と bench 使用中
  (`InstanceInUse`)しか見ておらず、同一チームの**他の**インスタンスが
  creating/deleting でもチェックしていなかった。
- 到達例: あるチームでインスタンス A が creating 中に、既に running の
  インスタンス B に対して DELETE を叩くと B が deleting へ遷移し、A(creating)
  と B(deleting)が同時に進行中になる。同様に片方が deleting 中にもう片方の
  delete を連打しても複数の deleting 行が生まれ得る。

**対応**: `requestDeleteInstance` に create 側と同じ team-wide ガードを追加。
authz → 対象自身の状態ガード(`InvalidInstanceTransition`)→ チーム全体の
進行中1本ガード(`ProvisionInProgress`、対象自身は除外して他の行だけを見る)→
bench 使用中ガード(`InstanceInUse`)→ `beginDeleting` 遷移、の順で判定する
(対象自身の状態ガードを先に置くのは、それだけで 409 が確定するケースで
無駄な `listByTeam` を避けるため)。契約(`shared/src/api.ts`)の
`deleteTeamInstance` エンドポイントに既存の `ProvisionInProgress`(create 側と
共用、新規定義はしない)を `.addError` し、ハンドラの `catchTags` にも
マッピングを追加。

トレードオフ: failed インスタンスの自己整理(掃除目的の削除)も、チームに
他の進行中行がある間は同様にブロックされる。これは意図的な許容
(ユーザーは進行中の1本が片付くのを待てばよく、実害は無い)。

## 今度対応(このスコープ外)

- コンテストが running でない間はインスタンス自体へアクセスできなくする仕組みは
  未実装。ネットワーク/Access 側のゲーティングが要るため別タスク。

## 2nd codex round(#A/#B、Task 6 実装後の再レビュー)

### #A `requestCreateInstance` の index 採番が failed/deleting の枠を再利用してしまう【真のバグ・対応した】

- #1 対応後の採番は `existing` のうち `creating`/`running` の index だけを
  除外して `1..instanceQuota` の最小空きを選んでいた。`failed`(や `deleting`)
  の行は quota カウントに入らないため、その index を新規作成が再利用でき、
  vmid/IP も同じ値になる。後でその `failed` 行を削除すると新インスタンスの
  VM ごと撤収されてしまう(vmid/IP 衝突による VM 破壊)。
- **対応**: 除外対象を「`deleted` 以外の全ステータス」に拡大し、探索範囲も
  `1..instanceQuota` ではなく `1..MAX_INSTANCE_INDEX`(=99、vmid/IP 不変条件を
  保つ上限)に広げた。空きが尽きた場合(実運用では到達不能)は `QuotaExceeded`
  を安全弁として返す。
  `portal/src/application/usecases/instances.ts` の `requestCreateInstance`。

### #B `requestDeleteInstance` の team-wide 進行中ガードが TOCTOU【真のバグ・対応した】

- #4 で追加したチーム全体の進行中ガードは `listByTeam` で読んでから
  `update` するという二段階実装だったため、2 つの並行削除リクエスト(または
  作成と削除の競合)が両方とも読み取りを通過し、両方が `deleting` へ書き込め
  てしまう(スペック §Instance 集約 不変条件2 違反)。
- **対応**: `InstanceRepo` に `beginDeletingIfAllowed`(単一の
  `UPDATE ... WHERE status IN ('running','failed') AND NOT EXISTS (...)
  RETURNING` 文)を追加し、`createIfAllowed` と同じ原子性パターンで
  読み取り+書き込みを 1 操作に統合した。`requestDeleteInstance` は
  この結果が `None` のときだけ再読み込みして原因(対象不在 / 対象の状態が
  running/failed でなくなった / 他の進行中に競り負けた)を優先順位付けて
  判定する。`portal/src/infrastructure/sql/repos/instanceRepo.ts` /
  `portal/src/application/ports.ts` / `portal/src/application/usecases/instances.ts`。

## 3回目 codex ラウンドの指摘(#A/#B 修正後)

### #C Team ページが mutation 成功後の refresh 失敗でポーリングを止める【UI・対応した】

- 追加/削除リクエストが成功しても、直後の `loadInstances` が一時的に失敗すると
  ヘルパーがエラーを握り潰し、mutation 前のリストが state に残る。ポーリングは
  リストに `creating`/`deleting` があるときだけ開始するため、リトライが
  スケジュールされず、リロードするまで画面が stale(削除ボタンも復活)。
- **対応**: mutation 成功時に返る pending インスタンスを楽観的に反映し、
  リフレッシュ失敗後もポーリング(リトライ)が継続するようにする。
  `portal/web/src/pages/Team.tsx`。

### #D 削除とベンチ enqueue の競合【P1・記録 → Task 7 で対応】

- 削除の bench 使用中チェック(`InstanceInUse`)は依然として read-then-act。
  ベンチ enqueue と削除が並行すると、削除側が「使用中ジョブなし」を観測した
  直後に enqueue がジョブを挿入し、両方成功して**走行中/キュー中ベンチの対象
  VM を撤去**しうる。`beginDeletingIfAllowed` はインスタンス行しか原子ガードし
  ておらず、enqueue 側も「対象が running のまま」を原子的に主張しない。
- **なぜ今すぐ直さないか**: 正しい修正はインスタンス status とベンチ挿入を
  またぐクロステーブルの原子ガード(共有トランザクション/条件付き挿入)が必要で、
  専用の設計・テストに値する。実効リスクは低い(私物・チーム数人・操作はほぼ
  逐次で逐次なら既存 `InstanceInUse` が防ぐ・失敗ベンチは再実行可能)。
- **対応予定**: Task 7(本番検証)前後で、削除の bench 使用中判定を
  `beginDeletingIfAllowed` の SQL に畳み込む + enqueue 挿入を「対象が running」
  条件付きにする、の双方向原子化として対応する。

### #E failed 行と (team,index) の衝突で削除が 500【P2・記録 → 今後対応】

- 部分ユニークインデックス `(team_id, idx)` は `failed` を除外しており、admin
  作成パス(`createInstance`、index を明示指定)も failed を除外しないため、
  `failed@idx` と `running@idx` が併存し得る。この状態で `failed@idx` を削除
  すると `deleting@idx` へ遷移し、ユニークインデックス違反 → `RepoError` →
  HTTP 500(想定していた「failed 掃除」が壊れる)。
- self-service の採番は #A で failed スロットを再利用しなくなったが、admin パス
  とスキーマの許容が根本原因として残る。
- **対応予定**: admin 作成パスの index 検証(failed と衝突する index を弾く)
  か、`beginDeletingIfAllowed` でユニーク違反を検出して制御されたエラーに
  マップする。今後対応。
