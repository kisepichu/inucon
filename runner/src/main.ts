// benchvm 常駐プロセスのエントリポイント(brief §main.ts、スペック §4)。
//
// 環境変数:
//   PORTAL_URL(必須): ポータルのベース URL
//   RUNNER_TOKEN(必須): ポータルと共有する bearer token(空文字は拒否)
//   POLL_INTERVAL_MILLIS(既定 2000): job なし時のポーリング間隔
//   PROGRESS_INTERVAL_MILLIS(既定 5000): 実行中の progress 報告間隔
//   BENCH_DIR(既定 /home/kise/private-isu/benchmarker): privateIsuAdapter が
//     直接 process.env から読む(runner/src/adapters/privateIsu.ts)。
//
// グレースフルシャットダウン: NodeRuntime.runMain が SIGINT/SIGTERM で
// runLoop の fiber を interrupt する。実行中のベンチプロセスは runJob が
// Effect.scoped(Command.start(...)) で包んでいるため、interrupt 時にスコープの
// ファイナライザが走ってプロセスも kill される。
import { HttpApiClient, HttpClient, HttpClientRequest } from "@effect/platform"
import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer, Option, Redacted } from "effect"
import { api } from "shared"
import { privateIsuAdapter } from "./adapters/privateIsu.js"
import { AdapterRegistry, LoopConfig, PortalClient, runLoop } from "./loop.js"

// 空文字(空白のみ含む)の RUNNER_TOKEN を拒否する。portal 側
// (portal/src/infrastructure/http/middleware.ts の runnerTokenConfig)と
// 同じ理由・同じ形の検証。
const runnerTokenConfig = Config.redacted("RUNNER_TOKEN").pipe(
  Config.validate({
    message: "RUNNER_TOKEN must be non-empty",
    validation: (token) => Redacted.value(token).trim() !== ""
  })
)

const LoopConfigLive = Layer.effect(
  LoopConfig,
  Effect.all({
    pollIntervalMillis: Config.integer("POLL_INTERVAL_MILLIS").pipe(Config.withDefault(2000)),
    progressIntervalMillis: Config.integer("PROGRESS_INTERVAL_MILLIS").pipe(Config.withDefault(5000)),
    // Task 10: heartbeat 用の識別子。RUNNER_ID は spec §Global Constraints の
    // team slot と同じく複数 runner を将来サポートするための識別子で、既定は
    // "benchvm" (現行 1 台構成)。RUNNER_REVISION は spec の「Dev may use 'dev'」
    // 節に沿って既定 "dev" とし、production では agenix secret (Task 14) で
    // 具体的な git commit hash 等を明示的に注入する運用にする (空文字は拒否)。
    // 空文字を拒否する validate は Config.withDefault の後ろでも実行されるが、
    // 既定 "dev" が空でない以上通常はここには到達しない (env で空文字を強制した
    // 場合のみ発火する防御ガード)。
    runnerId: Config.string("RUNNER_ID").pipe(Config.withDefault("benchvm")),
    runnerRevision: Config.string("RUNNER_REVISION").pipe(
      Config.withDefault("dev"),
      Config.validate({
        message: "RUNNER_REVISION must be non-empty",
        validation: (v) => v.trim() !== ""
      })
    ),
    // BENCH_DIR は privateIsuAdapter が process.env から読む場所と同じにする
    // (spec §4)。runner ローカル heartbeat が directory 実在 + read 可能性を
    // 検査するのに使う。既定は現行 benchvm の canonical パスと同じ。
    benchDir: Config.string("BENCH_DIR").pipe(
      Config.withDefault("/home/kise/private-isu/benchmarker")
    )
  })
)

// Phase 2 は private-isu のみ(スペック §5: 「2 問目(Phase 4)でこの抽象の
// 妥当性を検証する」)。
const AdapterRegistryLive = Layer.succeed(AdapterRegistry, {
  [privateIsuAdapter.problemKey]: privateIsuAdapter
})

const PortalClientLive = Layer.effect(
  PortalClient,
  Effect.gen(function* () {
    const portalUrl = yield* Config.string("PORTAL_URL")
    const token = yield* runnerTokenConfig
    const client = yield* HttpApiClient.make(api, {
      baseUrl: portalUrl,
      transformClient: (httpClient) =>
        HttpClient.mapRequest(
          httpClient,
          HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(token)}`)
        )
    })
    return {
      // Task 10: heartbeat payload を body に載せる新シグネチャ。ポータルは
      // runner_agents を touch → benchReady=true なら dequeue、false なら
      // Option.none() を返す。ここは payload をそのまま渡すだけ。
      poll: (payload) =>
        client.runner.pollJob({ payload }).pipe(Effect.map((res) => Option.fromNullable(res.job))),
      reportProgress: (jobId, payload) => client.runner.reportProgress({ path: { id: jobId }, payload }),
      reportFinish: (jobId, payload) => client.runner.reportFinish({ path: { id: jobId }, payload })
    }
  })
).pipe(Layer.provide(NodeHttpClient.layer))

const MainLive = Layer.mergeAll(PortalClientLive, AdapterRegistryLive, LoopConfigLive, NodeContext.layer)

runLoop.pipe(Effect.provide(MainLive), NodeRuntime.runMain)
