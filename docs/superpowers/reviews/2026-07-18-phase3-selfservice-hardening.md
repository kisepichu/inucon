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

## 今度対応(このスコープ外)

- コンテストが running でない間はインスタンス自体へアクセスできなくする仕組みは
  未実装。ネットワーク/Access 側のゲーティングが要るため別タスク。
