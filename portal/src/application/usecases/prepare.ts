import { Clock, Context, Effect, Layer, Option } from "effect"
import type { Contest } from "../../domain/contest.js"
import { InvalidContestTransition } from "../../domain/errors.js"
import type { ContestId, InstanceId, TeamId, UserId } from "../../domain/ids.js"
import { newInstance, vmidFor } from "../../domain/instance.js"
import type { Instance } from "../../domain/instance.js"
import { contestModeBlocker } from "../../domain/modeVmIds.js"
import type { NewOperation, Operation, OperationStep } from "../../domain/operation.js"
import type { Team } from "../../domain/team.js"
import { ContestModeNotActive, ContestNotFound } from "../errors.js"
import {
  ContestRepo,
  InstanceRepo,
  OperationExecutionError,
  OperationInProgress,
  OperationRepo,
  ProvisioningConfig,
  ProxmoxError,
  ProxmoxPort,
  RepoError,
  TeamRepo,
  UuidGen
} from "../ports.js"
import type { OperationHandler } from "../ports.js"
import { ENTER_CONTEST_MODE_TARGETS } from "./modeOperation.js"
import type { StepOutcome } from "./operations.js"
import { hostnameStemFor } from "./provisioning.js"

// Task 9: prepareContest Operation。preparing Contest の全 team を
// desiredInstanceCount まで収束させる。
//
// 設計 (spec §Step 5):
// - 単一 step (step_key = "converge_contest_instances") が Contest 全体の
//   team × instance を「1 台ずつ」構築していく。
// - 各 tick で:
//     1) Contest を再読して preparing 以外なら status=blocked で abort。
//     2) 別 team/instance が creating|deleting なら retryAt=now+2000 で待つ。
//     3) 未構築 (running 未達) の (team, index) が 1 件でもあれば:
//          a) 実際に Instance 行を createIfAllowed で追加する前に
//             getNodeFreeMemBytes ≥ PVE_MIN_FREE_BYTES を確認する。
//             低下していれば「first low-memory observation」を progress_json に
//             刻み、retryAt=now+KSM_POLL_MILLIS で待つ (KSM_SETTLE_TIMEOUT_MILLIS
//             を超えたら blocked)。回復したら observation はクリアして次へ進む。
//          b) OK なら 1 件だけ createIfAllowed({ owningOperationId: Some(opId) })。
//             以後は ProvisionerLive の saga が clone/route/access を進める。
//     4) 全 (team, index) が running まで到達したら status=succeeded。
// - Instance の外部書き込み (VM/DNS/ingress/App) は runProvisioning が
//   ResourceBinding に upsert する (Task 9 §Step 4)。crash → 再入時は
//   inventory + canonical key で復元される。
// - AmbiguousAccessPolicy は runProvisioning から Instance を failed に落として
//   終わる (Instance.errorMessage に描述され、prepare の retry はその Instance を
//   スキップして次の未構築枠へ進む — operator が手動整理して再 apply する
//   まで permanent stuck せず「該当 team だけ 1 枠欠け」で他 team は進める)。

export const PREPARE_STEP_KEY = "converge_contest_instances" as const

export interface PrepareConfigValue {
  readonly instanceRetryMillis: number
  readonly ksmPollMillis: number
  readonly ksmSettleTimeoutMillis: number
}

export class PrepareConfig extends Context.Tag("app/PrepareConfig")<
  PrepareConfig,
  PrepareConfigValue
>() {}

export const DEFAULT_PREPARE_INSTANCE_RETRY_MILLIS = 2_000
export const DEFAULT_PREPARE_KSM_POLL_MILLIS = 10_000
export const DEFAULT_PREPARE_KSM_SETTLE_TIMEOUT_MILLIS = 600_000

export const PrepareConfigDefault: Layer.Layer<PrepareConfig> = Layer.succeed(
  PrepareConfig,
  {
    instanceRetryMillis: DEFAULT_PREPARE_INSTANCE_RETRY_MILLIS,
    ksmPollMillis: DEFAULT_PREPARE_KSM_POLL_MILLIS,
    ksmSettleTimeoutMillis: DEFAULT_PREPARE_KSM_SETTLE_TIMEOUT_MILLIS
  }
)

// prepareContest: preparing Contest に対して kind='prepare' の Operation を
// enqueue する。cross-lock (creating/deleting Instance あり) と unfinished
// Operation の存在は OperationRepo.enqueue の SQL 側 atomic ガードが検出する
// (呼び出し元は OperationInProgress として transmit する)。
//
// enqueue 前に Proxmox inventory を読み、競技モード (devvm stopped / benchvm
// running) でなければ ContestModeNotActive で拒否する。handler 自体は mode VM を
// 見ないので、normal mode のまま積むと KSM 待ち 10 分の末に ksm_settle_timeout で
// blocked になるだけで operator に理由が伝わらない。inventory が読めない
// (ProxmoxError) / mode VM が観測できない場合も積まない (fail closed)。
export type PrepareContestError =
  | RepoError
  | ContestNotFound
  | InvalidContestTransition
  | ContestModeNotActive
  | ProxmoxError
  | OperationInProgress

export const prepareContest = (args: {
  readonly contestId: ContestId
  readonly actorUserId: UserId
}): Effect.Effect<Operation, PrepareContestError, ContestRepo | OperationRepo | ProxmoxPort> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const contest = yield* contests.findById(args.contestId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ContestNotFound()),
          onSome: Effect.succeed
        })
      )
    )
    if (contest.status !== "preparing") {
      return yield* Effect.fail(
        new InvalidContestTransition({ from: contest.status, to: "preparing" })
      )
    }

    const inventory = yield* (yield* ProxmoxPort).getInfrastructureInventory
    const blocker = contestModeBlocker({
      devvm: Option.getOrNull(inventory.devvm),
      benchvm: Option.getOrNull(inventory.benchvm)
    })
    if (blocker !== null) {
      return yield* Effect.fail(new ContestModeNotActive({ reason: blocker }))
    }
    const operations = yield* OperationRepo
    const input: NewOperation = {
      contestId: contest.id,
      kind: "prepare",
      actor: { kind: "admin", userId: args.actorUserId },
      // plan_digest は prepare Operation では固定文字列を使う (reconciliation の
      // ような hostname 集合 hash に相当する source-of-truth を持たないため)。
      // 監査目的で kind と revision を含めるだけ。
      planDigest: `prepare:c${contest.id}:r${contest.revision}`,
      contestRevision: contest.revision,
      steps: [
        {
          stepKey: PREPARE_STEP_KEY,
          ordinal: 0,
          inputSummary: JSON.stringify({ contestId: contest.id }),
          continueOnError: false
        }
      ]
    }
    return yield* operations.enqueue(input)
  })

// step 実行時の progress_json 形。first low-memory observation の epoch millis を
// 保持する (回復したら null に戻す)。既存 progress_json は '{}' なので、
// 記録が無いときは lowMemorySinceMillis: null と等価に扱う。
interface PrepareStepProgress {
  readonly lowMemorySinceMillis: number | null
}

const parseProgress = (raw: string): PrepareStepProgress => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { lowMemorySinceMillis: null }
  }
  if (parsed === null || typeof parsed !== "object" || !("lowMemorySinceMillis" in parsed)) {
    return { lowMemorySinceMillis: null }
  }
  const value = parsed.lowMemorySinceMillis
  if (typeof value !== "number") return { lowMemorySinceMillis: null }
  return { lowMemorySinceMillis: value }
}

interface StepInput {
  readonly contestId: ContestId
}

const parseStepInput = (raw: string): StepInput | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || !("contestId" in parsed)) {
    return null
  }
  const value = parsed.contestId
  if (typeof value !== "string") return null
  return { contestId: value as unknown as ContestId }
}

// prepare が収束させる desired 枠 (team × 1..desiredInstanceCount) を
// (teamNumber, index) 昇順に並べたもの。occupant は deleted 以外でその枠を占有して
// いる Instance (running / failed / creating / deleting)。handler は occupant の無い
// 枠だけをこの順に 1 台ずつ作る。failed も枠を占有する (operator の再削除・手動整理を
// 要求するので prepare は作り直さず次の枠に進む)。
//
// Admin Web の確認画面 (GET /api/admin/contests/:id/preparation-plan) と handler は
// どちらもこの関数だけで作成対象を決める — 判定を 2 箇所に持たない (PR #77)。
export interface PrepareSlot {
  readonly teamId: TeamId
  readonly teamNumber: number
  readonly teamName: string
  readonly index: number
  readonly hostname: string
  // 作成予定の枠は newInstance と同じ vmidFor、既存枠は occupant の vmid。
  readonly vmid: number
  readonly occupant: Instance | null
}

export const planPrepareSlots = (args: {
  readonly teams: ReadonlyArray<Team>
  readonly instances: ReadonlyArray<Instance>
}): ReadonlyArray<PrepareSlot> =>
  args.teams
    .slice()
    .sort((a, b) => a.teamNumber - b.teamNumber)
    .flatMap((team) =>
      Array.from({ length: team.desiredInstanceCount }, (_, i): PrepareSlot => {
        const index = i + 1
        const occupant =
          args.instances.find((inst) => inst.teamId === team.id && inst.index === index && inst.status !== "deleted") ??
          null
        return {
          teamId: team.id,
          teamNumber: team.teamNumber,
          teamName: team.name,
          index,
          hostname: hostnameStemFor(team.teamNumber, index),
          vmid: occupant?.vmid ?? vmidFor(team.teamNumber, index),
          occupant
        }
      })
    )

export interface PreparationPlan {
  readonly contestId: ContestId
  readonly contestMode: typeof ENTER_CONTEST_MODE_TARGETS
  readonly instanceSlots: ReadonlyArray<PrepareSlot>
}

// GET /api/admin/contests/:id/preparation-plan: 競技モード切替とインスタンス準備の
// 確認画面に出す影響対象。DB と domain 定数だけで組み立て、mutation も Proxmox
// 読み取りもしない (backend の enqueue 時 gate が authoritative)。
export const getPreparationPlan = (
  contestId: ContestId
): Effect.Effect<PreparationPlan, RepoError | ContestNotFound, ContestRepo | TeamRepo | InstanceRepo> =>
  Effect.gen(function* () {
    if (Option.isNone(yield* (yield* ContestRepo).findById(contestId))) {
      return yield* Effect.fail(new ContestNotFound())
    }
    const [teams, instances] = yield* Effect.all([
      (yield* TeamRepo).listByContest(contestId),
      (yield* InstanceRepo).listByContest(contestId)
    ])
    return {
      contestId,
      contestMode: ENTER_CONTEST_MODE_TARGETS,
      instanceSlots: planPrepareSlots({ teams, instances })
    }
  })

// review round 2 finding 1: succeeded の条件は「全 team で running 数が
// desiredInstanceCount 以上」。failed は healthy でないので数に入れない。
// 未達なら (failed が枠を消費して slot が無いケースを含めて) blocked に
// 落として operator 判断を仰ぐ。
interface RunFailedCounts {
  readonly totalRunning: number
  readonly totalFailed: number
  readonly allTeamsRunning: boolean
}

const countRunningVsFailed = (args: {
  readonly teams: ReadonlyArray<Team>
  readonly instances: ReadonlyArray<Instance>
}): RunFailedCounts => {
  let totalRunning = 0
  let totalFailed = 0
  let allTeamsRunning = true
  for (const team of args.teams) {
    const teamInstances = args.instances.filter((i) => i.teamId === team.id)
    const running = teamInstances.filter((i) => i.status === "running").length
    const failed = teamInstances.filter((i) => i.status === "failed").length
    totalRunning += running
    totalFailed += failed
    if (running < team.desiredInstanceCount) {
      allTeamsRunning = false
    }
  }
  return { totalRunning, totalFailed, allTeamsRunning }
}

const anyTransitional = (instances: ReadonlyArray<Instance>): boolean =>
  instances.some((i) => i.status === "creating" || i.status === "deleting")

const anyRunning = (instances: ReadonlyArray<Instance>): boolean =>
  instances.some((i) => i.status === "running")

// step 実行本体。worker から (kind='prepare', stepKey='converge_contest_instances') で
// 呼ばれる。返り値 StepOutcome の意味は operations.ts と同じ。
export const makePrepareHandler: Effect.Effect<
  OperationHandler,
  never,
  | ContestRepo
  | InstanceRepo
  | TeamRepo
  | ProxmoxPort
  | OperationRepo
  | UuidGen
  | ProvisioningConfig
  | PrepareConfig
> = Effect.gen(function* () {
  const contests = yield* ContestRepo
  const instances = yield* InstanceRepo
  const teams = yield* TeamRepo
  const proxmox = yield* ProxmoxPort
  const operations = yield* OperationRepo
  const uuid = yield* UuidGen
  const provisioningConfig = yield* ProvisioningConfig
  const prepareConfig = yield* PrepareConfig

  const run = (step: OperationStep): Effect.Effect<StepOutcome, OperationExecutionError> =>
    Effect.gen(function* () {
      const parsed = parseStepInput(step.inputSummary)
      if (parsed === null) {
        return { status: "blocked" as const, summary: "invalid_step_input" }
      }
      const contestOpt = yield* contests.findById(parsed.contestId)
      if (Option.isNone(contestOpt)) {
        return { status: "blocked" as const, summary: "contest_not_found" }
      }
      const contest: Contest = contestOpt.value
      // spec §Step 5: 「re-read Contest first, block without new provider
      // mutation if it is no longer preparing」。scheduled finalization / cancel
      // が prepare のロング実行中に走ったケースを取り漏らさない。
      if (contest.status !== "preparing") {
        return {
          status: "blocked" as const,
          summary: `contest_no_longer_preparing:${contest.status}`
        }
      }

      const teamList = yield* teams.listByContest(contest.id)
      const instList = yield* instances.listByContest(contest.id)
      const now = yield* Clock.currentTimeMillis

      // spec: 「retry with retryAt=now+2000 while an Instance is creating/deleting」。
      // 別 team の 1 台が saga 実行中なら DB 側 cross-lock が createIfAllowed を
      // 拒否するので、明示的に retry で待つ。
      if (anyTransitional(instList)) {
        return {
          status: "retry" as const,
          retryAt: now + prepareConfig.instanceRetryMillis,
          summary: "waiting_for_saga"
        }
      }

      // Task 9 review round 2 finding 1: failed は「desired 枠を消費したが healthy で
      // ない」状態。failed が枠を占有していると次の未占有枠は無く slot=null になるが、
      // それは「収束済み」ではなく「operator 判断待ち」なので、succeeded への遷移は
      // 下の allTeamsRunning (running 数が desired に達している) のときだけに絞る。
      const slot = planPrepareSlots({ teams: teamList, instances: instList }).find((s) => s.occupant === null) ?? null
      if (slot === null) {
        // review round 2 finding 1: 全 index が「running または failed」で埋まった
        // ときに slot が null になる。succeeded は「全 team で running == desired」の
        // ときだけ返す。failed が残っているなら operator 判断待ちで blocked、
        // summary に count を載せて何が起きたかを機械的に区別できるようにする
        // (混在 succeeded/failed で終わっていた場合、UI 側が「一部失敗を
        // 見落として next step へ進む」ことを避ける)。
        const counts = countRunningVsFailed({ teams: teamList, instances: instList })
        if (counts.allTeamsRunning) {
          return { status: "succeeded" as const, summary: "all_instances_converged" }
        }
        return {
          status: "blocked" as const,
          summary: `all_slots_consumed_running=${counts.totalRunning}_failed=${counts.totalFailed}`
        }
      }

      // 2 台目以降で initial creating が saga で running まで至った後にだけ
      // 次を要求する。「wait until running」は creating が消えた == transitional=false
      // で表現されるが、直近の running が memory を掴んだ直後は KSM がまだ
      // page を dedupe できていないことがあるため、running が 1 件でもあるなら
      // memory recheck を続ける。
      const previousProgress = parseProgress(step.progressJson)
      if (anyRunning(instList)) {
        const freeBytes = yield* proxmox.getNodeFreeMemBytes
        if (freeBytes < provisioningConfig.minFreeMemBytes) {
          const since = previousProgress.lowMemorySinceMillis ?? now
          if (previousProgress.lowMemorySinceMillis === null) {
            // review round 3 finding 2: KSM observation の DB 永続化は
            // 「worker restart 後も same-window で判定継続する」ための任意情報。
            // ここが RepoError で失敗しても Operation の step 進行は続けるべき
            // (Retry 後に observation を再取得できれば実害なく再収束する)。
            // catchAll で logError に畳み、handler は KSM 判定に進む。
            yield* operations
              .updateStepProgress(step.id, JSON.stringify({ lowMemorySinceMillis: since }))
              .pipe(
                Effect.catchAll((e) =>
                  Effect.logError(`prepare KSM observation persist failed: ${String(e)}`)
                )
              )
          }
          if (now - since >= prepareConfig.ksmSettleTimeoutMillis) {
            return {
              status: "blocked" as const,
              summary: `ksm_settle_timeout:free=${freeBytes}:need=${provisioningConfig.minFreeMemBytes}`
            }
          }
          return {
            status: "retry" as const,
            retryAt: now + prepareConfig.ksmPollMillis,
            summary: `ksm_wait:free=${freeBytes}`
          }
        }
        // 回復した: observation クリア (次サイクルでも再確認するので何もしなくても
        // 実質同じだが、blocked 判定のリセットを明示するため上書きする)。
        if (previousProgress.lowMemorySinceMillis !== null) {
          // review round 3 finding 2: recovery path も同じ理由で catchAll に。
          yield* operations
            .updateStepProgress(step.id, JSON.stringify({ lowMemorySinceMillis: null }))
            .pipe(
              Effect.catchAll((e) =>
                Effect.logError(`prepare KSM observation clear failed: ${String(e)}`)
              )
            )
        }
      }

      // spec: quota は Contest.instanceQuota。desiredInstanceCount ≤ instanceQuota
      // は wizard 側で強制されるはずだが、防御的に quota を渡す。
      const id = (yield* uuid.next) as unknown as InstanceId
      const instance = newInstance({
        id,
        contestId: contest.id,
        teamId: slot.teamId,
        index: slot.index,
        teamNumber: slot.teamNumber,
        now
      })
      yield* instances.createIfAllowed(instance, contest.instanceQuota, {
        owningOperationId: Option.some(step.operationId)
      })

      // 追加できた: ProvisionerLive の saga が次 tick で pick up して clone/
      // route/access を進める。この step は次 tick 以降 anyTransitional=true の
      // 分岐に落ちて待つ。
      return {
        status: "retry" as const,
        retryAt: now + prepareConfig.instanceRetryMillis,
        summary: `enqueued_team${slot.teamNumber}_idx${slot.index}`
      }
    }).pipe(Effect.catchAll((cause) => Effect.fail(new OperationExecutionError({ cause }))))

  return { run }
})
