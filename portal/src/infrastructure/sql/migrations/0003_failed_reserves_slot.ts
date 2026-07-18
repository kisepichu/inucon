import { SqlClient } from "@effect/sql"
import { Data, Effect } from "effect"

// 0002_selfservice.ts が定義する MigrationDataError と同じ _tag/形状の複製。
// 【重要】Migrator の本番ローダー(client.ts の migrationsLoader =
// SqliteMigrator.fromFileSystem)は各 migration ファイルを
// `import(/* @vite-ignore */ "<abs path>/000N_xxx.ts")` という「vite の変換を
// 経ない生の動的 import」で個別に読み込む(@effect/sql の Migrator/FileSystem.ts
// 参照)。この経路では相対 import の拡張子解決(TS の "*.js" 指定 → 実体
// "*.ts" へのマッピング)が効かず、migration ファイルが兄弟 migration ファイル
// を相対 import すると「Cannot find module '.../0002_selfservice.js'」で
// migration 全体が読み込み不能になる(実際に確認済み)。そのため 0001/0002 が
// 各々自己完結している既存方針に合わせ、0002 から import せずこのファイル内で
// 同じ _tag のエラー型を再定義する(Migrator は _tag で分類するため、
// クラスの同一性ではなく _tag 文字列が一致していれば十分)。
export class MigrationDataError extends Data.TaggedError("MigrationDataError")<{
  readonly message: string
}> {}

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
// 【Task 6 レビュー #J】#G は「重複側(failed を優先して倒す)を deleted に
// 書き換えて自動整理してから索引を張る」defensive reconciliation だったが、
// これはデータを破壊しうるため撤回する。admin の台帳取り込み経路
// (instanceRepo.create)は任意の vmid と subnet 有効な privateIp を許すため、
// 同じ (team_id, idx) に存在する failed 行は「使い捨て可能な重複」とは限らず、
// 実在する別の VM の台帳行かもしれない。そうした行を #G のように黙って
// deleted へ倒すと、その VM を指すレコードがどこにも残らなくなり(vmid/IP
// を握ったまま)、実 VM が誰にも解体されず孤立する事故になる。
//
// 対策: CREATE UNIQUE INDEX の前に、各 (team_id, idx) グループで deleted
// 以外の行が複数ある(= 索引作成が失敗する)ことを検出したら、行を書き換え
// たりせず migration を MigrationDataError で中断する(0002 の孤立 instances
// 行数不一致チェックと同じ fail-fast パターン、同じ型を再利用する)。
// エラーメッセージには重複している team_id/idx を列挙し、運用者が手動で
// (実 VM の状態を Proxmox 側で確認したうえで)reconcile できるようにする。
// self-service(Phase 3)は本番未稼働のため、現状の想定シナリオでは重複行は
// 存在せず、通常はそのまま CREATE UNIQUE INDEX に進む。
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const duplicates = yield* sql<{ teamId: string; idx: number; count: number }>`
    SELECT team_id AS teamId, idx, COUNT(*) AS count
    FROM instances
    WHERE status != 'deleted'
    GROUP BY team_id, idx
    HAVING COUNT(*) > 1
  `

  if (duplicates.length > 0) {
    const detail = duplicates.map((d) => `(team_id=${d.teamId}, idx=${d.idx}, count=${d.count})`).join(", ")
    yield* Effect.fail(
      new MigrationDataError({
        message:
          `migration 0003: (team_id, idx) が重複する deleted 以外の instances 行が見つかりました: ${detail}。` +
          `0002 の緩い部分ユニークインデックス(failed を対象外)と admin の台帳取り込み(重複判定なし)により、` +
          `failed 行が実在する別の VM を指している可能性があるため自動整理はしません。` +
          `Proxmox 側の実 VM 状態を確認したうえで、片方を deleted にする/vmid・idx を修正するなど手動で` +
          `reconcile してから migration を再実行してください。`
      })
    )
  }

  yield* sql`DROP INDEX idx_instances_team_idx_active`

  yield* sql`
    CREATE UNIQUE INDEX idx_instances_team_idx_active
    ON instances (team_id, idx)
    WHERE status != 'deleted'
  `
})
