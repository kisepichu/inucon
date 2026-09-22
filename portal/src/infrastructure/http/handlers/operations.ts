import { HttpApiBuilder } from "@effect/platform"
import { Effect, Option } from "effect"
import {
  AmbiguousReconciliation,
  api,
  ContestNotPreparing,
  ContestRevisionConflict,
  InstanceNotFound,
  InvalidContestTransition,
  NotFound,
  NothingToReconcile,
  OperationalContestConflict,
  ProviderUnavailable,
  RehearsalInstanceNotRunning,
  ResidualManagedResource,
  StaleReconciliationPlan,
  TargetIpOutOfSubnet,
  TeamJobAlreadyQueued
} from "shared"
import { CurrentUser } from "shared"
import { ContestRepo, OperationRepo } from "../../../application/ports.js"
import { enqueueRehearsal } from "../../../application/usecases/bench.js"
import { requestContestStart } from "../../../application/usecases/contestAdmin.js"
import {
  applyReconciliation,
  planReconciliation
} from "../../../application/usecases/reconciliation.js"
import { computeReadiness } from "../../../application/usecases/readiness.js"
import { cleanupContestResources, returnNormalMode } from "../../../application/usecases/cleanup.js"

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
    // Task 10: admin rehearsal enqueue。domain / application 側で決めた
    // TaggedError を wire schema にマップする (privateIp / bearer は絶対に載せない)。
    .handle("enqueueRehearsal", ({ path, payload }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        return yield* enqueueRehearsal({
          contestId: path.contestId,
          instanceId: payload.instanceId,
          actor: user
        })
      }).pipe(
        // domain BenchJob は Option フィールドを持つため wire schema (null 許容) に
        // 畳んで返す (benchGroup と同じ方針)。
        Effect.map((job) => ({
          ...job,
          score: Option.getOrNull(job.score),
          passed: Option.getOrNull(job.passed),
          errorMessage: Option.getOrNull(job.errorMessage),
          startedAt: Option.getOrNull(job.startedAt),
          finishedAt: Option.getOrNull(job.finishedAt),
          lastProgressAt: Option.getOrNull(job.lastProgressAt)
        })),
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          InstanceNotFound: () =>
            Effect.fail(new InstanceNotFound({ instanceId: payload.instanceId })),
          // 非 admin は URL の存在自体を隠す (privateIp / VMID を漏らさない)。
          // rehearsal はそもそも admin 専用エンドポイントで、middleware で 403
          // に落とすため application 側 Forbidden は防御的ケース。
          Forbidden: () => Effect.fail(new NotFound()),
          ContestNotPreparing: (e) => Effect.fail(new ContestNotPreparing({ status: e.status })),
          InstanceNotRunning: (e) =>
            Effect.fail(new RehearsalInstanceNotRunning({ instanceId: e.instanceId })),
          TeamJobAlreadyQueued: (e) =>
            Effect.fail(new TeamJobAlreadyQueued({ teamId: e.teamId })),
          TargetIpOutOfSubnet: (e) =>
            Effect.fail(new TargetIpOutOfSubnet({ ip: e.ip, teamNumber: e.teamNumber }))
        }),
        Effect.orDie
      )
    )
    // Task 10: preparing → running を Operation 経由で開始する。202 相当で
    // Operation を返し、UI は他 mutation と同じく Operation を polling する。
    // 実 readiness 再計算 / saveIfRevision は worker が動かす start handler で行う。
    .handle("requestContestStart", ({ path, payload }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        return yield* requestContestStart(path.contestId, payload.expectedRevision, user.id)
      }).pipe(
        Effect.map((op) => ({
          ...op,
          sanitizedError: Option.getOrNull(op.sanitizedError),
          startedAt: Option.getOrNull(op.startedAt),
          finishedAt: Option.getOrNull(op.finishedAt)
        })),
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          ContestRevisionConflict: (e: { readonly expected: number; readonly actual: number }) =>
            Effect.fail(new ContestRevisionConflict({ expected: e.expected, actual: e.actual })),
          InvalidContestTransition: (e: { readonly from: unknown; readonly to: unknown }) =>
            Effect.fail(
              new InvalidContestTransition({ from: e.from as never, to: e.to as never })
            ),
          // 既に別 Operation が走っているときは 409 に落とす (reconciliation apply と同型)。
          OperationInProgress: () => Effect.fail(new OperationalContestConflict())
        }),
        Effect.orDie
      )
    )
    // Task 12: cleanup Operation の enqueue。planDigest 一致検証 + blocked / adopt 判定は
    // reconciliation apply と同型。生 hostname/vmid は返さない (ambiguous なら hostname のみ)。
    .handle("requestContestCleanup", ({ path, payload }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        return yield* cleanupContestResources({
          contestId: path.contestId,
          planDigest: payload.planDigest,
          actorUserId: user.id
        })
      }).pipe(
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
          OperationInProgress: () => Effect.fail(new OperationalContestConflict())
        }),
        Effect.orDie
      )
    )
    // Task 12: return_normal_mode Operation の enqueue。ResidualManagedResource は
    // 「先に cleanup を完了させてください」を UI に伝えるための 409。
    .handle("requestReturnNormalMode", ({ path }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        return yield* returnNormalMode({ contestId: path.contestId, actorUserId: user.id })
      }).pipe(
        Effect.map((op) => ({
          ...op,
          sanitizedError: Option.getOrNull(op.sanitizedError),
          startedAt: Option.getOrNull(op.startedAt),
          finishedAt: Option.getOrNull(op.finishedAt)
        })),
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          ProxmoxError: () => Effect.fail(new ProviderUnavailable({ provider: "proxmox" })),
          OperationInProgress: () => Effect.fail(new OperationalContestConflict()),
          ResidualManagedResource: (e: { readonly hostnames: ReadonlyArray<string> }) =>
            Effect.fail(new ResidualManagedResource({ hostnames: e.hostnames })),
          // review round 3 #2: return_normal_mode は finished / canceled 以外の
          // Contest に対する呼び出しを弾く。UI へは既存の InvalidContestTransition
          // (409) を使い、from/to の状態を透過的に伝える。
          InvalidContestTransition: (e: { readonly from: unknown; readonly to: unknown }) =>
            Effect.fail(new InvalidContestTransition({ from: e.from as never, to: e.to as never }))
        }),
        Effect.orDie
      )
    )
    // Task 13: OperationDetail 用の Operation 単体取得。Operation + steps を
    // ordinal 昇順で返す。domain の Option フィールド (retryAt / leaseExpiresAt /
    // resultSummary / sanitizedError / startedAt / finishedAt) はすべて境界で
    // null に畳む (BenchJob / Operation と同じ方針)。
    .handle("getAdminOperation", ({ path }) =>
      Effect.gen(function* () {
        const ops = yield* OperationRepo
        const opt = yield* ops.findById(path.operationId)
        if (Option.isNone(opt)) {
          return yield* Effect.fail(new NotFound())
        }
        const op = opt.value
        const steps = yield* ops.listSteps(path.operationId)
        return {
          ...op,
          sanitizedError: Option.getOrNull(op.sanitizedError),
          startedAt: Option.getOrNull(op.startedAt),
          finishedAt: Option.getOrNull(op.finishedAt),
          steps: steps.map((s) => ({
            ...s,
            retryAt: Option.getOrNull(s.retryAt),
            leaseExpiresAt: Option.getOrNull(s.leaseExpiresAt),
            resultSummary: Option.getOrNull(s.resultSummary),
            sanitizedError: Option.getOrNull(s.sanitizedError),
            startedAt: Option.getOrNull(s.startedAt),
            finishedAt: Option.getOrNull(s.finishedAt)
          }))
        }
      }).pipe(Effect.orDie)
    )
    // Task 13: ContestAdmin の Operations タブ用一覧。limit は 20 既定 / 100 上限。
    // Contest 存在チェックはリスト応答が空 [] と区別が付かなくなるのを避けるため
    // 明示的に行う (findById → NotFound マップ)。
    .handle("listContestOperations", ({ path, urlParams }) =>
      Effect.gen(function* () {
        const contests = yield* ContestRepo
        const contest = yield* contests.findById(path.contestId)
        if (Option.isNone(contest)) {
          return yield* Effect.fail(new NotFound())
        }
        const raw = urlParams.limit === undefined ? 20 : Number.parseInt(urlParams.limit, 10)
        const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 100) : 20
        const ops = yield* OperationRepo
        const rows = yield* ops.listByContest(path.contestId, limit)
        return rows.map((op) => ({
          ...op,
          sanitizedError: Option.getOrNull(op.sanitizedError),
          startedAt: Option.getOrNull(op.startedAt),
          finishedAt: Option.getOrNull(op.finishedAt)
        }))
      }).pipe(Effect.orDie)
    )
)
