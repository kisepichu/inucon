// private-isu 用アダプタ(Phase 2 で唯一の問題)。
// 実行コマンド/cwd は problems/private-isu/README.md「ベンチ実行(benchvm から)」
// 節の実測手順(`cd ~/private-isu/benchmarker && ./bin/benchmarker -u ./userdata
// -t http://<targetIp>`)と整合させる。
import { Either, Option } from "effect"
import type { BenchCommandSpec, BenchResult, BenchTarget } from "./types.js"
import { AdapterParseError, type ProblemAdapter } from "./types.js"

const DEFAULT_BENCH_DIR = "/home/kise/private-isu/benchmarker"

// BENCH_DIR は main.ts の Config 経由ではなく直接 process.env を読む: アダプタ
// の command() は(loop.ts からの合成のしやすさのため)純粋な同期関数という
// 契約(brief §アダプタ契約)であり、Effect の Config を経由できないため。
const benchDir = (): string => {
  const value = process.env["BENCH_DIR"]
  return value !== undefined && value.trim() !== "" ? value : DEFAULT_BENCH_DIR
}

const command = (target: BenchTarget): BenchCommandSpec => ({
  cmd: "./bin/benchmarker",
  args: ["-u", "./userdata", "-t", `http://${target.ip}:${target.port}/`],
  cwd: benchDir()
})

// stdout の最後の "{" 始まり行を返す(無ければ undefined)。ベンチマーカーは
// 実行ログの後に最終結果の JSON を 1 行 stdout に吐くため、末尾から探す。
const lastJsonLine = (stdout: string): string | undefined => {
  const lines = stdout.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith("{")) {
      return trimmed
    }
  }
  return undefined
}

interface RawBenchmarkerOutput {
  readonly pass: boolean
  readonly score: number
  readonly messages?: ReadonlyArray<string>
}

const isRawBenchmarkerOutput = (value: unknown): value is RawBenchmarkerOutput =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { pass?: unknown }).pass === "boolean" &&
  typeof (value as { score?: unknown }).score === "number"

const parseResult = (stdout: string): Either.Either<BenchResult, AdapterParseError> => {
  const line = lastJsonLine(stdout)
  if (line === undefined) {
    return Either.left(new AdapterParseError({ message: "benchmarker stdout に JSON 行が見つからない" }))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (e) {
    return Either.left(
      new AdapterParseError({ message: `benchmarker stdout の最後の JSON 行のパースに失敗: ${String(e)}` })
    )
  }

  if (!isRawBenchmarkerOutput(parsed)) {
    return Either.left(new AdapterParseError({ message: "benchmarker の JSON 出力の形式が想定外(pass/score が無い)" }))
  }

  return Either.right({
    passed: parsed.pass,
    score: parsed.score,
    messages: parsed.messages ?? []
  })
}

// private-isu の公式ベンチマーカーは完走するまで途中スコアを出力しないため、
// 常に none(スペック §5 の「進捗表示用(任意)」)。
const parsePartialScore = (_stdoutSoFar: string): Option.Option<number> => Option.none()

export const privateIsuAdapter: ProblemAdapter = {
  problemKey: "private-isu",
  command,
  parseResult,
  parsePartialScore
}
