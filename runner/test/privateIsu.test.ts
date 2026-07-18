import { Either, Option } from "effect"
import { describe, expect, it } from "vitest"
import { privateIsuAdapter } from "../src/adapters/privateIsu.js"

// 実ベンチ出力サンプル。problems/private-isu/README.md「実測結果」節の表
// (2vCPU/4GB, 再ベンチ 3 回)の 2 回目(score 1030, success 897, fail 0,
// 全て pass:true)を、README に載っている失敗時の実出力行
// (`{"pass":false,"score":74,"success":71,"fail":1,"messages":[...]}`)と
// 同じ {pass, score, success, fail, messages} 形式に転記して固定データ化した
// もの(表には生 JSON 行までは載っていないため、表の数値をこの形式に当てはめた)。
const REAL_BENCH_OUTPUT_LINE = '{"pass":true,"score":1030,"success":897,"fail":0,"messages":[]}'

describe("privateIsuAdapter.command", () => {
  it("benchmarker バイナリを BENCH_DIR 配下・-u ./userdata -t http://<ip>:<port>/ で起動する", () => {
    const spec = privateIsuAdapter.command({ ip: "10.100.1.11", port: 80 })
    expect(spec.cmd).toBe("./bin/benchmarker")
    expect(spec.args).toEqual(["-u", "./userdata", "-t", "http://10.100.1.11:80/"])
    expect(spec.cwd.length).toBeGreaterThan(0)
  })
})

describe("privateIsuAdapter.parseResult", () => {
  it("実ベンチ出力(score 1030 台)から passed/score を取れる", () => {
    const result = privateIsuAdapter.parseResult(REAL_BENCH_OUTPUT_LINE)
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.passed).toBe(true)
      expect(result.right.score).toBe(1030)
    }
  })

  it("stdout にログ行や旧い JSON 行が混在しても最後の { 始まり行を採用する", () => {
    const stdout = [
      "=== POST /login ===",
      "GET /initialize -> 200",
      '{"pass":false,"score":74,"success":71,"fail":1,"messages":["stale"]}',
      "=== running load phase ===",
      REAL_BENCH_OUTPUT_LINE,
      ""
    ].join("\n")
    const result = privateIsuAdapter.parseResult(stdout)
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.passed).toBe(true)
      expect(result.right.score).toBe(1030)
    }
  })

  it("実ベンチの fail 出力(pass:false)も passed:false として取れる", () => {
    const result = privateIsuAdapter.parseResult(
      '{"pass":false,"score":74,"success":71,"fail":1,"messages":["ステータスコードが正しくありません: expected 200, got 400 (GET /posts/10001)"]}'
    )
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.passed).toBe(false)
      expect(result.right.score).toBe(74)
      expect(result.right.messages).toHaveLength(1)
    }
  })

  it("JSON 行が全く無い stdout は left(AdapterParseError)になる", () => {
    const result = privateIsuAdapter.parseResult("panic: invalid argument to IntN\nexit status 2\n")
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("AdapterParseError")
    }
  })

  it("最後の { 始まり行が壊れた JSON の場合も left になる", () => {
    const result = privateIsuAdapter.parseResult('some log\n{"pass":true, "score": }\n')
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("privateIsuAdapter.parsePartialScore", () => {
  it("private-isu は途中スコア出力が無いため常に none", () => {
    expect(Option.isNone(privateIsuAdapter.parsePartialScore(REAL_BENCH_OUTPUT_LINE))).toBe(true)
  })
})
