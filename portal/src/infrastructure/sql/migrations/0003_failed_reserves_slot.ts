import { SqlClient } from "@effect/sql"
import { Clock, Effect } from "effect"

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
// 【Task 6 レビュー #G】当初「self-service instances(Phase 3)はまだ本番稼働
// 前であり、既存行がこの厳格化後のインデックスに違反することはないためデータ
// クリーンアップは不要」と判断していたが、これは楽観的すぎた。
// 0002 の緩い部分ユニークインデックス(failed を対象外)と、admin の
// createInstance(instanceRepo.create、(team_id, idx) の重複判定を持たない
// 台帳取り込み専用経路)の両方が、同じ (team_id, idx) に failed と
// creating/running/deleting が共存する状態を作りうる。そのまま
// 「DROP INDEX → CREATE UNIQUE INDEX ... WHERE status != 'deleted'」を実行
// すると、既にそうした重複行が存在する DB では CREATE UNIQUE INDEX 自体が
// UNIQUE 制約違反で失敗し、migration 全体がロールバックされて起動不能になる
// (Migrator は各 migration を1トランザクションで包むため、この失敗は
// 「起動できない」という形で露呈する)。
//
// 対策: CREATE UNIQUE INDEX の前に、各 (team_id, idx) グループで deleted
// 以外の行が複数ある場合は 1 行だけ残して残りを deleted に倒す(defensive
// reconciliation)。生き残らせる行の優先順位:
//   1. failed でない行を failed の行より優先する(failed 行は「vmid/IP を
//      握ったまま实質使われていない」使い捨て可能な重複という前提、上の
//      #E コメント参照)
//   2. 優先順位が同じ場合は updated_at が新しい方を優先する
//   3. さらに同じ場合は id で決定的にする(SQLite に安定ソートを頼らない)
// この「生存者選定」は 1 本の UPDATE ... WHERE EXISTS(...) 文で表現する:
// ある行 r は、同じ (team_id, idx) グループ内に r より優先順位が高い別の
// deleted 以外の行が存在する場合にだけ deleted へ倒す。優先順位はグループ内
// で相異なる id により厳密な全順序になるため、各グループでちょうど 1 行
// (最優先の行)だけが生き残る。
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const now = yield* Clock.currentTimeMillis

  yield* sql`
    UPDATE instances
    SET status = 'deleted', updated_at = ${now}
    WHERE status != 'deleted'
      AND EXISTS (
        SELECT 1 FROM instances AS other
        WHERE other.team_id = instances.team_id
          AND other.idx = instances.idx
          AND other.id != instances.id
          AND other.status != 'deleted'
          AND (
            (CASE WHEN other.status != 'failed' THEN 1 ELSE 0 END)
              > (CASE WHEN instances.status != 'failed' THEN 1 ELSE 0 END)
            OR (
              (CASE WHEN other.status != 'failed' THEN 1 ELSE 0 END)
                = (CASE WHEN instances.status != 'failed' THEN 1 ELSE 0 END)
              AND (
                other.updated_at > instances.updated_at
                OR (other.updated_at = instances.updated_at AND other.id > instances.id)
              )
            )
          )
      )
  `

  yield* sql`DROP INDEX idx_instances_team_idx_active`

  yield* sql`
    CREATE UNIQUE INDEX idx_instances_team_idx_active
    ON instances (team_id, idx)
    WHERE status != 'deleted'
  `
})
