import { Effect, Option } from "effect"
import type { ReadinessCheck } from "shared/schemas"
import type { Contest } from "../../domain/contest.js"
import type { ContestId } from "../../domain/ids.js"
import { modeVmIdentityMismatch } from "../../domain/modeVmIds.js"
import { ContestNotFound } from "../errors.js"
import {
  BackupPort,
  BenchJobRepo,
  CloudflarePort,
  ContestRepo,
  InstanceRepo,
  ProxmoxPort,
  RepoError,
  ResourceBindingRepo,
  RunnerAgentRepo,
  RunnerConfig
} from "../ports.js"
import type { ProxmoxInfrastructureInventory } from "../ports.js"

// Task 8: readiness aggregation。
//
// - readiness は Contest / provider の state を一切 mutate しない。
// - 各 check は stable key(portal_db / previous_cleanup / template / team_slots /
//   isolation / memory / capacity_estimate / benchvm / mode_vm_identity /
//   cloudflare_token / cloudflare_inventory / cloudflare_write_proven / runner /
//   backup / rehearsal)
//   と summary(非機密文字列: 生 email / bearer / cause は絶対に含めない)を返す。
// - Task 10/11 で実装される runner/backup/rehearsal/cloudflare_write_proven は
//   ここでは warn を返し、start は「required key が pass、capacity_estimate は
//   warn 許容、warn-until-later は warn 許容」で判定する。

// spec §readiness key set。実装は「見つからない key を start で pass 扱いに
// しない」ため、start required は明示的に列挙する。capacity_estimate は
// start までに benchvm が実起動しているので post-mode の実測が正となり、
// このリストからは除外する(warn 扱い)。cloudflare_write_proven も start
// までは書き込み実績が無くて自然なので warn に留める。
//
// Task 10 で runner / backup / rehearsal を required に昇格した:
// - runner: heartbeat が新鮮かつ benchReady=true でないと start は事故る
//   (dequeue しても runner が拾えず job が timeout する)。
// - backup: 開始後に snapshot 取得の口が無い状態で走らせない (Task 11 の
//   finalization が blocked になる)。
// - rehearsal: 少なくとも 1 回 admin が rehearsal を成功させてから start する
//   (Access + route + adapter の end-to-end 疎通が実証されていない状態で
//   一斉開始しないためのセーフティ)。
export const START_REQUIRED_CHECK_KEYS: ReadonlyArray<string> = [
  "portal_db",
  "previous_cleanup",
  "template",
  "team_slots",
  "isolation",
  "memory",
  "benchvm",
  "mode_vm_identity",
  "cloudflare_token",
  "cloudflare_inventory",
  "runner",
  "backup",
  "rehearsal"
]

// preparing 遷移(beginContestPreparation)前検査で必ず pass を要求する key。
// readiness の中で 1 key だけを最小限使う(unfinished_operation / transitional_instance は
// contestAdmin 側で個別に判定する — readiness は Contest スコープでは無いため)。
export const PREPARATION_REQUIRED_CHECK_KEYS: ReadonlyArray<string> = ["previous_cleanup"]

// preparing 遷移で「先に潰しておくべき」ブロック理由の可読キー。
// contestAdmin.ts が集約し、readiness と組み合わせて ContestNotReadyForPreparation.
// failingChecks に載せる。
export const PREPARATION_BLOCK_KEYS = {
  previousCleanup: "previous_cleanup",
  unfinishedOperation: "unfinished_operation",
  transitionalInstance: "transitional_instance"
} as const

// Task 8: mode/memory の判定閾値。post-shutdown MemAvailable (= 現在 free +
// devvm 停止で解放される RAM) が benchvm 起動要求 + host reserve を満たすかを見る。
// 1 GiB reserve は spec §Instance / spike メモ §リスク4 と同じ根拠。
const HOST_MEMORY_RESERVE_BYTES = 1 * 1024 * 1024 * 1024

// team1/team2 は現行 network slot(spec §Global Constraints)の必須集合。
// team3 以降は runbook の手作業(NIC 増設 + NixOS network)経由でのみ増える。
const REQUIRED_TEAM_NUMBERS: ReadonlyArray<number> = [1, 2]

// Task 8: previous_cleanup 判定に使う "not deleted" 判定。idx_instances_vmid_active
// の predicate と一致させる(spec §readiness Step 4)。
const isActiveInstanceStatus = (status: string): boolean => status !== "deleted"

// 個々の provider inventory 取得を Either 化する。成功なら Some、失敗なら None
// を返し、summary/error は呼び出し側で readiness key に畳む。生 error 詳細は
// summary には残さない(spec §credential:「Access email 一覧を operation
// log / response に残さない」と同型で、readiness 応答は非機密のみ)。
const optionalInventory: Effect.Effect<
  Option.Option<ProxmoxInfrastructureInventory>,
  never,
  ProxmoxPort
> = Effect.gen(function* () {
  const px = yield* ProxmoxPort
  const result = yield* Effect.either(px.getInfrastructureInventory)
  return result._tag === "Right" ? Option.some(result.right) : Option.none()
})

const cloudflareTokenCheck: Effect.Effect<ReadinessCheck, never, CloudflarePort> = Effect.gen(function* () {
  const cf = yield* CloudflarePort
  const result = yield* Effect.either(cf.probe)
  return result._tag === "Right"
    ? { key: "cloudflare_token", status: "pass" as const, summary: "Cloudflare API token verify: active" }
    : { key: "cloudflare_token", status: "fail" as const, summary: "Cloudflare API token verify failed" }
})

const cloudflareInventoryCheck: Effect.Effect<ReadinessCheck, never, CloudflarePort> = Effect.gen(function* () {
  const cf = yield* CloudflarePort
  const result = yield* Effect.either(cf.getInstanceInventory)
  return result._tag === "Right"
    ? {
        key: "cloudflare_inventory",
        status: "pass" as const,
        summary: `Cloudflare inventory readable (${result.right.routes.length} route(s), ${result.right.apps.length} app(s))`
      }
    : { key: "cloudflare_inventory", status: "fail" as const, summary: "Cloudflare inventory read failed" }
})

// previous_cleanup: 「status ∈ (finished, canceled) の Contest に status !=
// 'deleted' の Instance が 1 件でも残っていれば fail」。idx_instances_vmid_active
// の predicate と一致させる(failed 行が vmid を掴んだままでもエディション N+1
// と衝突するため)。
const previousCleanupCheck = (
  contests: ReadonlyArray<Contest>
): Effect.Effect<ReadinessCheck, RepoError, InstanceRepo> =>
  Effect.gen(function* () {
    const repo = yield* InstanceRepo
    const closed = contests.filter((c) => c.status === "finished" || c.status === "canceled")
    let residualCount = 0
    for (const c of closed) {
      const instances = yield* repo.listByContest(c.id)
      residualCount += instances.filter((i) => isActiveInstanceStatus(i.status)).length
    }
    return residualCount === 0
      ? {
          key: "previous_cleanup",
          status: "pass" as const,
          summary: "no residual instances from prior editions"
        }
      : {
          key: "previous_cleanup",
          status: "fail" as const,
          summary: `${residualCount} residual instance(s) still hold vmid/IP from a prior edition`
        }
  })

const templateCheck = (
  inventory: Option.Option<ProxmoxInfrastructureInventory>
): ReadinessCheck =>
  Option.match(inventory, {
    onNone: () => ({
      key: "template",
      status: "fail" as const,
      summary: "Proxmox inventory unreadable"
    }),
    onSome: (inv) =>
      inv.templateExists
        ? { key: "template", status: "pass" as const, summary: "template VM 9100 present" }
        : { key: "template", status: "fail" as const, summary: "template VM 9100 not found in inventory" }
  })

const teamSlotsCheck = (
  inventory: Option.Option<ProxmoxInfrastructureInventory>
): ReadinessCheck =>
  Option.match(inventory, {
    onNone: () => ({
      key: "team_slots",
      status: "fail" as const,
      summary: "Proxmox inventory unreadable"
    }),
    onSome: (inv) => {
      const missing = REQUIRED_TEAM_NUMBERS.filter((n) => !inv.preparedTeamNumbers.includes(n))
      return missing.length === 0
        ? {
            key: "team_slots",
            status: "pass" as const,
            summary: `team slots ready: ${inv.preparedTeamNumbers.slice().sort((a, b) => a - b).join(",")}`
          }
        : {
            key: "team_slots",
            status: "fail" as const,
            summary: `missing team slot(s): ${missing.join(",")} (runbook required for team3+)`
          }
    }
  })

const isolationCheck = (
  inventory: Option.Option<ProxmoxInfrastructureInventory>
): ReadinessCheck =>
  Option.match(inventory, {
    onNone: () => ({
      key: "isolation",
      status: "fail" as const,
      summary: "Proxmox inventory unreadable"
    }),
    onSome: (inv) =>
      inv.isolationServiceActive
        ? { key: "isolation", status: "pass" as const, summary: "inucon-team-isolation service active" }
        : {
            key: "isolation",
            status: "fail" as const,
            summary: "inucon-team-isolation service is not active"
          }
  })

const memoryCheck = (
  inventory: Option.Option<ProxmoxInfrastructureInventory>
): ReadinessCheck =>
  Option.match(inventory, {
    onNone: () => ({ key: "memory", status: "fail" as const, summary: "Proxmox inventory unreadable" }),
    onSome: (inv) => {
      // post-shutdown MemAvailable = 現在の free + devvm 停止で解放される RAM。
      // devvm が既に stopped ならその分は加算しない(実際に解放されるのは
      // running → stopped の 1 回だけ)。
      const devvmReleasable = inv.devvm.status === "running" ? inv.devvm.memoryBytes : 0
      const projectedAvailable = inv.nodeFreeMemBytes + devvmReleasable
      const required = inv.benchvm.memoryBytes + HOST_MEMORY_RESERVE_BYTES
      return projectedAvailable >= required
        ? {
            key: "memory",
            status: "pass" as const,
            summary: `post-shutdown MemAvailable ≥ benchvm(${inv.benchvm.memoryBytes}B) + reserve(${HOST_MEMORY_RESERVE_BYTES}B)`
          }
        : {
            key: "memory",
            status: "fail" as const,
            summary: `post-shutdown MemAvailable ${projectedAvailable}B < benchvm(${inv.benchvm.memoryBytes}B) + reserve(${HOST_MEMORY_RESERVE_BYTES}B)`
          }
    }
  })

// capacity_estimate: 「preparing 中の Contest が要求する team VM 合計 RAM」が
// post-shutdown ノード RAM をどこまで食うかの概算警告。実測は Task 9 が
// team VM 起動時に memory_check step で個別に判定するのでここは warn 止まり。
const capacityEstimateCheck = (
  inventory: Option.Option<ProxmoxInfrastructureInventory>,
  contest: Contest
): ReadinessCheck =>
  Option.match(inventory, {
    onNone: () => ({
      key: "capacity_estimate",
      status: "warn" as const,
      summary: "Proxmox inventory unreadable; skipping capacity estimate"
    }),
    onSome: (inv) => {
      // desired total = quota * ~4 GiB (per-team-VM 実測は 4 GiB、Task 9 で確定)。
      const estimatedPerVm = 4 * 1024 * 1024 * 1024
      const desiredTotal = contest.instanceQuota * estimatedPerVm
      // 「benchvm が停止中」ならこの後の memory_check 直後に benchvm が起動して
      // その分ノード free が減る前提で見積もる。benchvm が既に running なら
      // inv.nodeFreeMemBytes は benchvm の RAM を既に控除済み(round 1 review
      // finding 1: そこから更に benchvm.memoryBytes を引くと二重控除で常に warn
      // に振れる)。同じ推論を memoryCheck / modeOperation.memory_check にも
      // 揃えてある。
      const devvmReleasable = inv.devvm.status === "running" ? inv.devvm.memoryBytes : 0
      const benchvmNeededExtra = inv.benchvm.status === "running" ? 0 : inv.benchvm.memoryBytes
      const postModeFree = inv.nodeFreeMemBytes + devvmReleasable - benchvmNeededExtra
      return desiredTotal <= postModeFree - HOST_MEMORY_RESERVE_BYTES
        ? {
            key: "capacity_estimate",
            status: "pass" as const,
            summary: `estimated ${desiredTotal}B team-VM RAM within post-mode free ${postModeFree}B`
          }
        : {
            key: "capacity_estimate",
            status: "warn" as const,
            summary: `estimated ${desiredTotal}B team-VM RAM exceeds post-mode free ${postModeFree}B (linked-clone KSM recovery may make room; Task 9 will re-check per instance)`
          }
    }
  })

const benchvmCheck = (
  inventory: Option.Option<ProxmoxInfrastructureInventory>
): ReadinessCheck =>
  Option.match(inventory, {
    onNone: () => ({ key: "benchvm", status: "fail" as const, summary: "Proxmox inventory unreadable" }),
    onSome: (inv) => ({
      key: "benchvm",
      status: "pass" as const,
      summary: `benchvm inventory present (status=${inv.benchvm.status}, onBoot=${inv.benchvm.onBoot})`
    })
  })

// mode_vm_identity: devvm / benchvm の observed name が期待名と一致するか。
// 不一致は「VMID mapping が実機とズレている」= mode transition が別 VM を
// 停止/起動しうる状態なので fail にして start を gate する(実際に
// DEVVM_VMID / BENCHVM_VMID が逆に定義されていた)。判定材料は observed
// name だけで、VMID から name を補完するような実装にはしない。
const modeVmIdentityCheck = (
  inventory: Option.Option<ProxmoxInfrastructureInventory>
): ReadinessCheck =>
  Option.match(inventory, {
    onNone: () => ({
      key: "mode_vm_identity",
      status: "fail" as const,
      summary: "Proxmox inventory unreadable"
    }),
    onSome: (inv) => {
      const mismatch = modeVmIdentityMismatch(inv)
      return mismatch === null
        ? {
            key: "mode_vm_identity",
            status: "pass" as const,
            summary: `observed names match expected mapping (devvm=${inv.devvm.vmid}, benchvm=${inv.benchvm.vmid})`
          }
        : { key: "mode_vm_identity", status: "fail" as const, summary: mismatch }
    }
  })

const portalDbCheck: Effect.Effect<ReadinessCheck, never, ContestRepo> = Effect.gen(function* () {
  const repo = yield* ContestRepo
  const result = yield* Effect.either(repo.list)
  return result._tag === "Right"
    ? { key: "portal_db", status: "pass" as const, summary: "portal DB reachable" }
    : { key: "portal_db", status: "fail" as const, summary: "portal DB unreachable" }
})

// Task 9: cloudflare_write_proven = Contest スコープに 1 件でも portal 所有の
// cloudflare binding が観測されているか。prepare Operation の外部書き込み
// (ensureInstanceRoute / ensureAccessAppExact)が成功したときにだけ Task 9 の
// runProvisioning saga が resource_bindings に upsert するため、これが 1 件で
// もあれば「今エディションで実際に CF に書けた証拠」になる。
const cloudflareWriteProvenCheck = (
  contestId: ContestId
): Effect.Effect<ReadinessCheck, never, ResourceBindingRepo> =>
  Effect.gen(function* () {
    const bindings = yield* ResourceBindingRepo
    const rows = yield* Effect.either(bindings.listByContest(contestId))
    if (rows._tag === "Left") {
      return {
        key: "cloudflare_write_proven",
        status: "warn",
        summary: "portal DB unreachable while reading resource bindings"
      } satisfies ReadinessCheck
    }
    const cloudflareOwned = rows.right.filter(
      (b) => b.provider === "cloudflare" && b.desiredState === "present"
    )
    if (cloudflareOwned.length === 0) {
      return {
        key: "cloudflare_write_proven",
        status: "warn",
        summary: "Cloudflare write path has not been exercised for this Contest yet"
      } satisfies ReadinessCheck
    }
    return {
      key: "cloudflare_write_proven",
      status: "pass",
      summary: `Cloudflare write path exercised (${cloudflareOwned.length} owned bindings)`
    } satisfies ReadinessCheck
  })

// Task 10: runner heartbeat / backup writability / rehearsal 成功実績を
// readiness key に落とす。すべて fail は「そのまま start すると事故が起きる」
// 状態なので required に昇格した (START_REQUIRED_CHECK_KEYS 参照)。

// runner: RunnerAgentRepo.getFresh が Some かつ benchReady=true なら pass。
// stale (maxAgeMillis 超過で None) または benchReady=false は fail。
// summary には runner id / revision / lastSeenAt を載せる(bearer/生 cause は
// 一切載せない — schema 側で length<=256 に強制)。
const runnerCheck: Effect.Effect<
  ReadinessCheck,
  never,
  RunnerAgentRepo | RunnerConfig
> = Effect.gen(function* () {
  const config = yield* RunnerConfig
  const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
  const repo = yield* RunnerAgentRepo
  const result = yield* Effect.either(repo.getFresh(now, config.maxAgeMillis))
  if (result._tag === "Left") {
    return {
      key: "runner",
      status: "fail",
      summary: "portal DB unreachable while reading runner heartbeat"
    } satisfies ReadinessCheck
  }
  const fresh = result.right
  if (Option.isNone(fresh)) {
    return {
      key: "runner",
      status: "fail",
      summary: `no runner heartbeat within ${config.maxAgeMillis}ms`
    } satisfies ReadinessCheck
  }
  const agent = fresh.value
  if (!agent.benchReady) {
    return {
      key: "runner",
      status: "fail",
      summary: `runner ${agent.id} rev ${agent.revision} reports benchReady=false`
    } satisfies ReadinessCheck
  }
  const ageMillis = now - agent.lastSeenAt
  return {
    key: "runner",
    status: "pass",
    summary: `runner ${agent.id} rev ${agent.revision} healthy (age=${ageMillis}ms)`
  } satisfies ReadinessCheck
})

// backup: BackupPort.probe の成否をそのまま反映する。probe は create/fsync/
// delete まで通ったら pass、それ以外は fail (BackupError の reason はそのまま
// 短い summary に落とす。詳細エラーメッセージは載せない)。
const backupCheck: Effect.Effect<ReadinessCheck, never, BackupPort> = Effect.gen(function* () {
  const backup = yield* BackupPort
  const result = yield* Effect.either(backup.probe)
  return result._tag === "Right"
    ? { key: "backup", status: "pass" as const, summary: "backup canary create/fsync/delete succeeded" }
    : { key: "backup", status: "fail" as const, summary: `backup probe failed: ${result.left.reason}` }
})

// rehearsal: 対象 Contest で少なくとも 1 回、passed=true の finished rehearsal
// が存在すれば pass。未実施なら fail (start 前に at-least-once の疎通実証を
// 強制する)。生 job id / score / errorMessage は載せない (readiness は
// 非機密 summary のみ)。
const rehearsalCheck = (
  contestId: ContestId
): Effect.Effect<ReadinessCheck, never, BenchJobRepo> =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const result = yield* Effect.either(jobs.countSuccessfulRehearsals(contestId))
    if (result._tag === "Left") {
      return {
        key: "rehearsal",
        status: "fail",
        summary: "portal DB unreachable while counting rehearsals"
      } satisfies ReadinessCheck
    }
    const count = result.right
    if (count === 0) {
      return {
        key: "rehearsal",
        status: "fail",
        summary: "no successful rehearsal recorded for this contest yet"
      } satisfies ReadinessCheck
    }
    return {
      key: "rehearsal",
      status: "pass",
      summary: `${count} successful rehearsal(s) recorded`
    } satisfies ReadinessCheck
  })

// computeReadiness の DB 失敗分離(review round 2 finding 3):
// portal DB が read できない状態でも readiness endpoint は 200 で
// portal_db=fail を含む配列を返さなければならない(HTTP handler は
// ContestNotFound のみ 404 に落とし、それ以外は Effect.orDie で 500 になる)。
// 以前は contests.findById / contests.list が Effect.either で囲われておらず、
// RepoError が top-level に伝播して 500 化していた。ここでは preamble を
// Effect.either で fence し、DB 失敗時は synthetic な portal_db=fail 配列に
// 畳んで返す。ContestNotFound はそのまま fail する(handler が 404 にする)。
const dbFailurePayload = (summary: string): ReadonlyArray<ReadinessCheck> => [
  { key: "portal_db", status: "fail" as const, summary },
  // 生 error message は summary に載せない(非機密のみ)。DB が落ちている
  // 間は残り check は「観測できず」を表す warn / fail に畳んで返す。
  { key: "previous_cleanup", status: "warn" as const, summary: "portal DB unreachable; skipping" },
  { key: "template", status: "warn" as const, summary: "portal DB unreachable; skipping" },
  { key: "team_slots", status: "warn" as const, summary: "portal DB unreachable; skipping" },
  { key: "isolation", status: "warn" as const, summary: "portal DB unreachable; skipping" },
  { key: "memory", status: "warn" as const, summary: "portal DB unreachable; skipping" },
  { key: "capacity_estimate", status: "warn" as const, summary: "portal DB unreachable; skipping" },
  { key: "benchvm", status: "warn" as const, summary: "portal DB unreachable; skipping" },
  { key: "mode_vm_identity", status: "warn" as const, summary: "portal DB unreachable; skipping" },
  { key: "cloudflare_token", status: "warn" as const, summary: "portal DB unreachable; skipping" },
  { key: "cloudflare_inventory", status: "warn" as const, summary: "portal DB unreachable; skipping" },
  { key: "cloudflare_write_proven", status: "warn" as const, summary: "portal DB unreachable; skipping" },
  // review round 1 #2: portal DB が読めない状態は observability が壊れて
  // start required に必要な heartbeat 行 / rehearsal 実績 / backup 出力先の
  // 整合が確認できない。runner / rehearsal は DB 依存で fail が自然、backup は
  // FS-based だが probe を試行していない (preamble fail で早期リターン) ので
  // "warn" ではなく "fail" として start required を defensive にブロックする。
  // 直前 comment との整合も揃える (3 key とも fail = start required で防止)。
  { key: "runner", status: "fail" as const, summary: "portal DB unreachable; runner heartbeat unknown" },
  { key: "backup", status: "fail" as const, summary: "portal DB unreachable; backup probe not attempted" },
  { key: "rehearsal", status: "fail" as const, summary: "portal DB unreachable; rehearsal history unknown" }
]

export const computeReadiness = (
  contestId: ContestId
): Effect.Effect<
  ReadonlyArray<ReadinessCheck>,
  ContestNotFound,
  | BackupPort
  | BenchJobRepo
  | CloudflarePort
  | ContestRepo
  | InstanceRepo
  | ProxmoxPort
  | ResourceBindingRepo
  | RunnerAgentRepo
  | RunnerConfig
> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const preamble = yield* Effect.either(
      Effect.gen(function* () {
        const target = yield* contests.findById(contestId)
        if (Option.isNone(target)) return { kind: "not_found" } as const
        const all = yield* contests.list
        return { kind: "ok", contest: target.value, all } as const
      })
    )
    if (preamble._tag === "Left") {
      return dbFailurePayload("portal DB unreachable")
    }
    if (preamble.right.kind === "not_found") {
      return yield* Effect.fail(new ContestNotFound())
    }
    const contest = preamble.right.contest
    const all = preamble.right.all
    const [
      portalDb,
      inventory,
      cfToken,
      cfInventory,
      previousCleanup,
      cfWriteProven,
      runnerResult,
      backupResult,
      rehearsalResult
    ] = yield* Effect.all(
      [
        portalDbCheck,
        optionalInventory,
        cloudflareTokenCheck,
        cloudflareInventoryCheck,
        Effect.either(previousCleanupCheck(all)).pipe(
          Effect.map((r) =>
            r._tag === "Right"
              ? r.right
              : ({
                  key: "previous_cleanup",
                  status: "fail" as const,
                  summary: "portal DB unreachable while listing instances"
                } as ReadinessCheck)
          )
        ),
        cloudflareWriteProvenCheck(contestId),
        runnerCheck,
        backupCheck,
        rehearsalCheck(contestId)
      ],
      { concurrency: "unbounded" }
    )
    return [
      portalDb,
      previousCleanup,
      templateCheck(inventory),
      teamSlotsCheck(inventory),
      isolationCheck(inventory),
      memoryCheck(inventory),
      capacityEstimateCheck(inventory, contest),
      benchvmCheck(inventory),
      modeVmIdentityCheck(inventory),
      cfToken,
      cfInventory,
      cfWriteProven,
      runnerResult,
      backupResult,
      rehearsalResult
    ]
  })

// 「previous_cleanup が pass か」を単発判定する。contestAdmin の
// beginContestPreparation ガードから直接呼ばれる。readiness 全体を計算する
// ほど重くない(Contest 一覧を舐めるだけで済む)ため、専用の関数として
// export する — computeReadiness の deferredWarnChecks 分を回避したい呼び出し用。
export const evaluatePreviousCleanup: Effect.Effect<
  ReadinessCheck,
  RepoError,
  ContestRepo | InstanceRepo
> = Effect.gen(function* () {
  const contests = yield* ContestRepo
  const all = yield* contests.list
  return yield* previousCleanupCheck(all)
})
