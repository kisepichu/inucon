import { Data } from "effect"

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
