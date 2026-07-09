// 問題アダプタ契約(スペック §5「問題アダプタ」、brief §アダプタ契約)。
// 「問題 = テンプレート ID + アダプタ」の「アダプタ」側で、ランナー内の TS
// モジュールとして実装する。Phase 2 は private-isu のみ(adapters/privateIsu.ts)。
import type { Either, Option } from "effect"
import { Data } from "effect"

// ベンチ対象(BenchJob の targetIp/targetPort をアダプタに渡す形)。
export interface BenchTarget {
  readonly ip: string
  readonly port: number
}

// アダプタの command() が返す起動情報。実際の起動(Command.make + Scope 管理)
// は loop.ts が担う(アダプタは起動コマンドの組み立てのみを担当し、プロセス
// 実行のライフサイクルには関与しない)。
export interface BenchCommandSpec {
  readonly cmd: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
}

// ベンチの最終結果(parseResult の成功値)。RunnerFinishRequest への変換は
// loop.ts が行う(messages は現時点では finish に載せない: スペックの
// RunnerFinishRequest に messages フィールドが無いため。ログとしては
// stdout そのものが logTail 経由でポータルに残る)。
export interface BenchResult {
  readonly passed: boolean
  readonly score: number
  readonly messages: ReadonlyArray<string>
}

// stdout のパースに失敗した(JSON 行が無い/JSON でない/期待した形でない)。
export class AdapterParseError extends Data.TaggedError("AdapterParseError")<{
  readonly message: string
}> {}

export interface ProblemAdapter {
  // BenchJob.problemKey(Contest.problemKey)と一致させ、loop.ts のレジストリで
  // この値をキーにアダプタを引く。
  readonly problemKey: string
  // ベンチバイナリの起動コマンド(cmd/args/cwd)を組み立てる。実行そのものは
  // 行わない(純粋関数)。
  readonly command: (target: BenchTarget) => BenchCommandSpec
  // プロセス終了後の stdout 全体から最終結果を取り出す。
  readonly parseResult: (stdout: string) => Either.Either<BenchResult, AdapterParseError>
  // 実行中の stdout(蓄積分)から途中スコアを取り出せる場合に返す(進捗表示用、
  // 任意)。private-isu は途中スコア出力が無いため常に Option.none()。
  readonly parsePartialScore: (stdoutSoFar: string) => Option.Option<number>
}
