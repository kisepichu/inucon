import { Data } from "effect"
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
