import { Data } from "effect"
import type { ContestStatus } from "../domain/contest.js"
import type { InstanceId, TeamId } from "../domain/ids.js"

// ユースケース(オーケストレーション)固有のエラー。
//
// domain/errors.ts に置かず application 側に置く理由: domain の集約(Contest /
// BenchJob 等)はそれ自体の不変条件違反のみを表現する(例: ContestNotRunning は
// Contest の状態、TeamJobAlreadyQueued は BenchJob キューの不変条件)。一方
// NotInTeam(「呼び出しユーザーがどのチームにも属さない」)と Forbidden
// (「操作対象が呼び出しユーザーのチームの所有物ではない」)は、集約単体の状態
// からは導けず、TeamRepo で「誰が呼んだか」を突き合わせて初めて分かるユース
// ケース側の認可判断。domain 層は Effect ランタイムに依存しないぶん「どの
// リポジトリから来たか」という文脈も持たないため、この 2 つは application
// 層のエラーとして定義する。
export class NotInTeam extends Data.TaggedError("NotInTeam")<{}> {}

export class Forbidden extends Data.TaggedError("Forbidden")<{}> {}

// 参照先の集約が存在しない(URL の :id が指す行が無い)。「どの集約が無いか」は
// 呼び出し元がハンドラ側の文脈(どのユースケースを呼んだか)で分かっているため、
// ここでは種別を分けない(auth の NotInTeam/Forbidden と同じ理由で、DB 由来の
// 状態というより「呼び出しユーザーの入力 ID を repo と突き合わせた結果」の
// ユースケース側エラー)。
export class TeamNotFound extends Data.TaggedError("TeamNotFound")<{}> {}

export class ContestNotFound extends Data.TaggedError("ContestNotFound")<{}> {}

// PUT /api/teams/:id/members: 渡された githubLogin のうち users に存在しない
// もの(= まだ一度もログインしていない GitHub アカウント)。
export class UnknownGithubLogins extends Data.TaggedError("UnknownGithubLogins")<{
  logins: ReadonlyArray<string>
}> {}

// PUT /api/teams/:id/members: 渡された githubLogin のうち、既に別チームに
// 所属しているユーザー。TeamRepo.setMembers は全量置換のため、黙って許すと
// 他チームから横取りしてしまう。409 で衝突ユーザー一覧を返す。
export class MemberConflict extends Data.TaggedError("MemberConflict")<{
  logins: ReadonlyArray<string>
}> {}

// POST /api/bench-jobs: instanceId 指定時に解決先の Instance が存在しない。
export class InstanceNotFound extends Data.TaggedError("InstanceNotFound")<{}> {}

// requestCreateInstance(Task 4): 該当チームの creating+running 数が既に
// Contest.instanceQuota 以上(スペック §Instance 集約 不変条件1)。InstanceRepo
// が quota 再検証 + INSERT を単一の原子的操作(createIfAllowed)で行うため、
// TeamJobAlreadyQueued と同じ「リポジトリが検出して返す」形のユースケース側
// エラー。
export class QuotaExceeded extends Data.TaggedError("QuotaExceeded")<{
  teamId: TeamId
  quota: number
}> {}

// requestCreateInstance(Task 4): 該当チームに進行中(creating/deleting)の
// オーケストレーションが既にある(スペック §Instance 集約 不変条件2、連打・
// 競合防止)。QuotaExceeded と同様 createIfAllowed が検出する。
export class ProvisionInProgress extends Data.TaggedError("ProvisionInProgress")<{
  teamId: TeamId
}> {}

// requestCreateInstance(Task 4): eevee の空き RAM が閾値未満(spike メモ
// §リスク4、既定 5GiB)。ProxmoxPort.getNodeFreeMemBytes は DB トランザクション
// の外側(別システムへの HTTP 呼び出し)で検証するため、DuplicateInstanceIndex
// 等とは違いリポジトリではなくユースケース自身が判定して返す。
export class InsufficientMemory extends Data.TaggedError("InsufficientMemory")<{
  freeBytes: number
  requiredBytes: number
}> {}

// requestDeleteInstance(Task 4): 削除対象の privateIp を targetIp とする
// BenchJob が queued/running(スペック §Instance 集約 不変条件4、ベンチ対象の
// 消失防止)。409 にマップする。
export class InstanceInUse extends Data.TaggedError("InstanceInUse")<{
  instanceId: InstanceId
}> {}

// enqueueBenchJob(Task 6 レビュー #3): instanceId 指定でベンチを投げる際、
// 対象 Instance が running でない(creating/deleting/deleted/failed)。
// deleted/failed な VM へ enqueue すると接続失敗でジョブ枠を浪費するだけなので、
// 事前に明示エラーで弾く。InstanceInUse と同様チーム所属確認の後に判定する。
export class InstanceNotRunning extends Data.TaggedError("InstanceNotRunning")<{
  instanceId: InstanceId
}> {}

// Task 7: reconciliation apply の失敗。plan digest が現在の (inventory + DB)
// から再計算した digest と食い違う = ブラウザが古い plan を送っている / 別 admin
// が既に変えた等。詳細は返さない(生 inventory を含まない一様な typed error)。
// spec §Reconciliation: "ambiguous は apply を block し、runbook と対象 ID を
// 表示する" — その典型が unmanaged_orphan + adopt 未確認、および ambiguous 分類。
// 呼び出し元は plan.entries に何が blocked かを見て操作者に確認を促す。
export class StaleReconciliationPlan extends Data.TaggedError("StaleReconciliationPlan")<{}> {}

export class AmbiguousReconciliation extends Data.TaggedError("AmbiguousReconciliation")<{
  readonly hostnames: ReadonlyArray<string>
}> {}

// Task 7 review #2: 「plan は正当だが actionable な entry が 0 件」= 既に clean
// を、AmbiguousReconciliation(hostnames=[]) で表現していたが、これは blocked
// orphan と同じ 422 応答になり client 側から区別できなかった。専用エラーを
// 用意して 409 (Conflict: 適用対象なし) に落とす。UI は「既に clean です」
// と表示できる。
export class NothingToReconcile extends Data.TaggedError("NothingToReconcile")<{}> {}

// Task 11: markOffHostVerified が呼び出し元表示 SHA-256 と DB 側の sha256 の
// 一致を要求する。不一致は operator に「再取得してください」の 409 を返す。
// 生の cause / path は絶対に載せない。actual は artifact.sha256、expected は
// 呼び出し元入力(いずれも 64 桁 hex)。
export class ArtifactChecksumMismatch extends Data.TaggedError("ArtifactChecksumMismatch")<{
  readonly expected: string
  readonly actual: string
}> {}

// Task 11 review round 1 finding 1: verifyArtifactChecksum が
// ArtifactRepo.findById(None) を「artifact 行不存在」と分類する専用型。
// 従来は ContestNotFound を再利用して HTTP 層でも 404 に畳めるので実害は
// なかったが、_tag で分岐する未来の caller が「contest 不在」と混同するのを
// 防ぐため型を分ける。
export class ArtifactNotFound extends Data.TaggedError("ArtifactNotFound")<{}> {}
// Task 11: legacy archive-only regenerate の enqueue 時に Contest が
// finished でないと 409 を返す。contest.status は enum なので情報漏えいなし。
export class InvalidArchiveState extends Data.TaggedError("InvalidArchiveState")<{
  readonly status: ContestStatus
}> {}

// Task 12: return_normal_mode の verify_no_managed_vms step が「まだ inucon-team*
// の managed VM が Proxmox に存在する」ことを検出した場合に返す。cleanup を
// 先に完了させる必要があることを operator に明示する。生 VMID / hostname は
// summary に残すが、raw provider payload は載せない。
export class ResidualManagedResource extends Data.TaggedError("ResidualManagedResource")<{
  readonly hostnames: ReadonlyArray<string>
}> {}
