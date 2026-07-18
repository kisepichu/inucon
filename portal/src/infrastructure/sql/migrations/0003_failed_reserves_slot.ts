import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

// Task 6 レビュー #E: 0002 で作った部分ユニークインデックス
// idx_instances_team_idx_active(status IN ('creating','running','deleting'))は
// failed を対象外にしていた。これはアプリ層の不変条件と食い違っている。
//
// requestCreateInstance(instances.ts)の occupiedIndices は「deleted 以外
// (creating/running/deleting/failed)」を占有中として index 選定から除外する
// (Task 6 レビュー #A で修正済み)。理由: failed 行も
// vmid = 1000 + teamNumber*100 + idx / IP = 10.100.<tn>.1<idx> という
// 決定的な採番で実際の VM を握ったまま(完全に削除されるまで)残る。
// にもかかわらず DB 側の部分ユニークインデックスは failed を対象外にしていた
// ため、failed@idx と running@idx が同じ (team_id, idx) で共存できてしまい:
//   - admin の createInstance が failed 行と同じ idx で新規 INSERT できて
//     しまう(vmid/IP衝突、後段で failed 行を掃除すると別 VM を破壊しうる)
//   - failed 行を自己サービスの削除(deleting へ遷移)しようとした際、後から
//     生まれた running 行と (team_id, idx) が重複していると UNIQUE 制約違反
//     → RepoError → HTTP 500(本来は起こり得ないはずの内部エラー)になる
// という2つの経路でアプリ層の allocator と DB のインデックスが矛盾していた。
//
// 修正: 部分ユニークインデックスの述語を「status != 'deleted'」に変更する。
// これで creating/running/deleting/failed の全てが (team_id, idx) スロットを
// 予約し、deleted になって初めてそのスロットが解放される。アプリ層の
// occupiedIndices の条件(status !== "deleted")と完全に一致する。
//
// SQLite は既存インデックスの述語を ALTER INDEX で変更できないため、
// DROP INDEX → CREATE UNIQUE INDEX で作り直す(テーブル自体のスキーマ変更は
// 不要、0002 のようなテーブル再作成は不要)。
//
// 本番(apphost)への安全性: self-service instances(Phase 3)はまだ本番稼働
// 前であり、既存行がこの厳格化後のインデックスに違反することはない
// (violate しうる行が存在しないため、データクリーンアップは不要)。
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`DROP INDEX idx_instances_team_idx_active`

  yield* sql`
    CREATE UNIQUE INDEX idx_instances_team_idx_active
    ON instances (team_id, idx)
    WHERE status != 'deleted'
  `
})
