import { HttpApiBuilder } from "@effect/platform"
import { Effect, Option } from "effect"
import {
  AmbiguousReconciliation,
  api,
  NotFound,
  NothingToReconcile,
  OperationalContestConflict,
  ProviderUnavailable,
  StaleReconciliationPlan
} from "shared"
import { CurrentUser } from "shared"
import {
  applyReconciliation,
  planReconciliation
} from "../../../application/usecases/reconciliation.js"
import { computeReadiness } from "../../../application/usecases/readiness.js"

// Task 7: reconciliation plan/apply の HTTP handler。AdminOnly middleware は
// shared/api の group 定義側で付与済みなので、handler は CurrentUser を
// actorUserId として使うだけ。ambiguous / stale / revision conflict / not found
// を shared 側 TaggedError にマップする(status: 422 / 409 / 409 / 404)。
export const OperationsLive = HttpApiBuilder.group(api, "operations", (handlers) =>
  handlers
    .handle("planReconciliation", ({ path, payload }) =>
      planReconciliation({ contestId: path.contestId, adoptHostnames: payload.adoptHostnames }).pipe(
        // wire schema は instanceId: NullOr(InstanceId) だが domain は
        // Option<InstanceId>。境界で null に畳んで返す(BenchJob と同じ方針)。
        Effect.map((plan) => ({
          ...plan,
          entries: plan.entries.map((e) => ({
            ...e,
            instanceId: Option.getOrNull(e.instanceId)
          }))
        })),
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          // review round 3 #1: provider inventory 読み取り失敗を 500 defect に
          // せず 503 に落とす。UI は「provider 一時障害」を明示できる。
          ProxmoxError: () => Effect.fail(new ProviderUnavailable({ provider: "proxmox" })),
          CloudflareError: () => Effect.fail(new ProviderUnavailable({ provider: "cloudflare" }))
        }),
        Effect.orDie
      )
    )
    .handle("applyReconciliation", ({ path, payload }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        return yield* applyReconciliation({
          contestId: path.contestId,
          planDigest: payload.planDigest,
          adoptHostnames: payload.adoptHostnames,
          actorUserId: user.id
        })
      }).pipe(
        // Operation の wire 表現は sanitizedError/startedAt/finishedAt が
        // null 許容。境界で Option → null に畳む。
        Effect.map((op) => ({
          ...op,
          sanitizedError: Option.getOrNull(op.sanitizedError),
          startedAt: Option.getOrNull(op.startedAt),
          finishedAt: Option.getOrNull(op.finishedAt)
        })),
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          ProxmoxError: () => Effect.fail(new ProviderUnavailable({ provider: "proxmox" })),
          CloudflareError: () => Effect.fail(new ProviderUnavailable({ provider: "cloudflare" })),
          StaleReconciliationPlan: () => Effect.fail(new StaleReconciliationPlan()),
          AmbiguousReconciliation: (e: { readonly hostnames: ReadonlyArray<string> }) =>
            Effect.fail(new AmbiguousReconciliation({ hostnames: e.hostnames })),
          NothingToReconcile: () => Effect.fail(new NothingToReconcile()),
          // Task 7 review round 1 #1: 同時に別 reconcile Operation が queued/running な
          // ときの enqueue 失敗は 500 に落とさず 409 (OperationalContestConflict)
          // に落とす。他 admin と競合したことを client に明示する。
          OperationInProgress: () => Effect.fail(new OperationalContestConflict())
        }),
        Effect.orDie
      )
    )
    .handle("getContestReadiness", ({ path }) =>
      computeReadiness(path.contestId).pipe(
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound())
          // provider unavailability は readiness の各 check が個別に fail を
          // 返すので readiness 全体としては 200 で返る(UI が summary を表示)。
        }),
        Effect.orDie
      )
    )
)
