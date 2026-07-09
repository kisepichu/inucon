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
