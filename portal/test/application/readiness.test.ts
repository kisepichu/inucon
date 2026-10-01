import { it } from "@effect/vitest"
import { Effect, Layer, Option, TestClock } from "effect"
import { describe, expect } from "vitest"
import {
  BackupError,
  CloudflareError,
  ProxmoxError
} from "../../src/application/ports.js"
import type { ResourceBinding } from "../../src/domain/resourceBinding.js"
import type { Contest } from "../../src/domain/contest.js"
import type { Instance } from "../../src/domain/instance.js"
import type { Team } from "../../src/domain/team.js"
import type { ReadinessCheck } from "shared/schemas"
import {
  computeReadiness,
  START_REQUIRED_CHECK_KEYS
} from "../../src/application/usecases/readiness.js"
import { ContestId, InstanceId, TeamId } from "../../src/domain/ids.js"
import { makeContest, makeInstance, makeTeam } from "../support/factories.js"
import type {
  CloudflareInventorySeed,
  CloudflareTestOptions,
  InfrastructureInventorySeed,
  ProxmoxTestOptions
} from "../support/inMemory.js"
import {
  makeBackupPortTest,
  makeBenchJobRepoTest,
  makeCloudflarePortTest,
  makeContestRepoTest,
  makeInstanceRepoTest,
  makeProxmoxPortTest,
  makeResourceBindingRepoTest,
  makeRunnerAgentRepoTest,
  makeTeamRepoTest,
  RunnerConfigTest
} from "../support/inMemory.js"
import type { BenchJob } from "../../src/domain/benchJob.js"
import type { RunnerAgentTestRow } from "../support/inMemory.js"
import { makeBenchJob } from "../support/factories.js"
import { BenchJobId } from "../../src/domain/ids.js"

// Task 8 Step 1: readiness aggregation の application-level 契約を検証する。
//
// - 各 check は `pass` / `warn` / `fail` を返し、summary は非機密。
// - 未実装(Task 10/11 が実装する runner/backup/rehearsal/cloudflare_write_proven)
//   は warn を返す。start は capacity_estimate と warn-until-later 以外の
//   required key に pass を要求する。
// - readiness は Contest/provider の状態を一切 mutate しない。

const CONTEST_ID = ContestId.make("c-edition2")
const TEAM1_ID = TeamId.make("team1-preparing")

const findCheck = (
  checks: ReadonlyArray<ReadinessCheck>,
  key: string
): ReadinessCheck => {
  const c = checks.find((x) => x.key === key)
  if (c === undefined) throw new Error(`check ${key} not present in ${JSON.stringify(checks)}`)
  return c
}

// 現行 preparing Contest 用の最低構成。desiredInstanceCount=3 は edition2 の想定。
const preparingContest = makeContest({
  id: CONTEST_ID,
  edition: 2,
  status: "preparing",
  problemRevision: "2026-08",
  revision: 1,
  instanceQuota: 3
})

const team1 = makeTeam({
  id: TEAM1_ID,
  contestId: CONTEST_ID,
  teamNumber: 1,
  name: "team1",
  desiredInstanceCount: 3
})

// Proxmox inventory の「健全な既定」(template + devvm + benchvm + team1/team2 slots)。
// 個別テストは managedVms / inventory を上書きして分岐を作る。
const healthyInventory = {
  nodeFreeMemBytes: 20_000_000_000, // 20 GiB
  templateExists: true,
  devvm: { vmid: 9300, name: "devvm", status: "running" as const, memoryBytes: 8 * 1024 * 1024 * 1024, onBoot: true },
  benchvm: { vmid: 9200, name: "benchvm", status: "stopped" as const, memoryBytes: 4 * 1024 * 1024 * 1024, onBoot: false },
  preparedTeamNumbers: [1, 2] as ReadonlyArray<number>,
  isolationServiceActive: true
}

interface ReadinessLayerOptions {
  readonly contests?: ReadonlyArray<Contest>
  readonly instances?: ReadonlyArray<Instance>
  readonly teams?: ReadonlyArray<Team>
  readonly bindings?: ReadonlyArray<ResourceBinding>
  readonly proxmoxInventory?: InfrastructureInventorySeed
  readonly proxmoxFail?: ProxmoxTestOptions
  readonly cloudflareInventory?: CloudflareInventorySeed
  readonly cloudflareFail?: CloudflareTestOptions
  // Task 10: runner heartbeat / backup / rehearsal を差し込むオプション。
  // healthy な既定は「fresh runner 1 台 + backup probe 成功 + rehearsal 1 件成功」。
  readonly runnerAgents?: ReadonlyArray<RunnerAgentTestRow>
  readonly backupFailWith?: BackupError
  readonly benchJobs?: ReadonlyArray<BenchJob>
  readonly runnerMaxAgeMillis?: number
  readonly nowForFactories?: number
}

// 既定の nowForFactories: readiness の runnerCheck は Effect.clockWith で
// currentTimeMillis を取る。テスト内で Clock を差し替えないため実時刻を使う。
// initial の runnerAgents.lastSeenAt は「Date.now() - a few seconds」を渡す。
const buildLayer = (opts: ReadinessLayerOptions = {}) => {
  const contests = opts.contests ?? [preparingContest]
  const teams = opts.teams ?? [team1]
  const instances = opts.instances ?? []
  const proxmox = makeProxmoxPortTest({
    ...(opts.proxmoxFail ?? {}),
    infrastructureInventory: opts.proxmoxInventory ?? healthyInventory
  }).layer
  const cloudflare = makeCloudflarePortTest({
    ...(opts.cloudflareFail ?? {})
  }).layer
  const now = opts.nowForFactories ?? 0
  const defaultRunner: RunnerAgentTestRow = {
    id: "benchvm",
    revision: "test",
    benchReady: true,
    healthSummary: "ok",
    lastSeenAt: now
  }
  const defaultRehearsal = makeBenchJob({
    id: BenchJobId.make("bench-rehearsal-1"),
    contestId: CONTEST_ID,
    teamId: TEAM1_ID,
    targetIp: "10.100.1.11",
    status: "finished",
    purpose: "rehearsal",
    passed: Option.some(true),
    score: Option.some(100),
    enqueuedAt: now,
    startedAt: Option.some(now),
    finishedAt: Option.some(now)
  })
  return Layer.mergeAll(
    makeContestRepoTest(contests),
    makeInstanceRepoTest(instances),
    makeTeamRepoTest({ teams, memberships: [] }),
    makeResourceBindingRepoTest(opts.bindings ?? []),
    makeBenchJobRepoTest(opts.benchJobs ?? [defaultRehearsal]),
    makeRunnerAgentRepoTest(opts.runnerAgents ?? [defaultRunner]),
    makeBackupPortTest({ failWith: opts.backupFailWith }),
    RunnerConfigTest(600_000, opts.runnerMaxAgeMillis ?? 60_000),
    proxmox,
    cloudflare
  )
}

describe("computeReadiness の必須 key set", () => {
  it.effect("healthy な状態では start required key がすべて pass、warn-until-later は warn を返す", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      const expectedKeys: ReadonlyArray<string> = [
        "portal_db",
        "previous_cleanup",
        "template",
        "team_slots",
        "isolation",
        "memory",
        "capacity_estimate",
        "benchvm",
        "cloudflare_token",
        "cloudflare_inventory",
        "mode_vm_identity",
        "cloudflare_write_proven",
        "runner",
        "backup",
        "rehearsal"
      ]
      for (const k of expectedKeys) {
        expect(checks.some((c) => c.key === k)).toBe(true)
      }
      for (const k of START_REQUIRED_CHECK_KEYS) {
        expect(findCheck(checks, k).status).toBe("pass")
      }
      // cloudflare_write_proven は依然として warn (portal-owned binding が 0 件)。
      // capacity_estimate は memory 実測未実施の warn。
      expect(findCheck(checks, "cloudflare_write_proven").status).toBe("warn")
    }).pipe(Effect.provide(buildLayer()))
  )
})

describe("Task 10: runner heartbeat readiness", () => {
  it.effect("heartbeat が maxAgeMillis を超えて stale なら runner=fail", () =>
    Effect.gen(function* () {
      // TestClock を maxAge を大きく超えた時刻に進めておくと、lastSeenAt=0 の
      // heartbeat が「ancient」として getFresh に None を返させられる。
      yield* TestClock.adjust("60 seconds")
      const checks = yield* computeReadiness(CONTEST_ID)
      const runner = findCheck(checks, "runner")
      expect(runner.status).toBe("fail")
      expect(runner.summary).toContain("no runner heartbeat")
      // 生 bearer / 生 cause を含まない (schema max 256; ここでは spot check)。
      expect(runner.summary).not.toMatch(/Bearer/i)
    }).pipe(
      Effect.provide(
        buildLayer({
          runnerAgents: [
            {
              id: "benchvm",
              revision: "test",
              benchReady: true,
              healthSummary: "ok",
              lastSeenAt: 0
            }
          ],
          runnerMaxAgeMillis: 30_000
        })
      )
    )
  )

  it.effect("heartbeat が新鮮でも benchReady=false なら runner=fail", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      const runner = findCheck(checks, "runner")
      expect(runner.status).toBe("fail")
      expect(runner.summary).toContain("benchReady=false")
    }).pipe(
      Effect.provide(
        buildLayer({
          runnerAgents: [
            {
              id: "benchvm",
              revision: "test",
              benchReady: false,
              healthSummary: "adapter missing",
              lastSeenAt: 0
            }
          ]
        })
      )
    )
  )

  it.effect("healthSummary は非機密文字列で 256 文字以内(schema 側の CHECK と揃える)", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      const runner = findCheck(checks, "runner")
      expect(runner.summary.length).toBeLessThanOrEqual(256)
      // 生 email / bearer を含まない。
      expect(runner.summary).not.toMatch(/@/)
      expect(runner.summary).not.toMatch(/Bearer/i)
    }).pipe(Effect.provide(buildLayer()))
  )
})

describe("Task 10: backup probe readiness", () => {
  it.effect("BackupPort.probe が成功すれば backup=pass", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      expect(findCheck(checks, "backup").status).toBe("pass")
    }).pipe(Effect.provide(buildLayer()))
  )

  it.effect("BackupError.reason が summary に載る (但し詳細メッセージは載せない)", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      const backup = findCheck(checks, "backup")
      expect(backup.status).toBe("fail")
      expect(backup.summary).toContain("not_writable")
      expect(backup.summary).not.toContain("EACCES")
    }).pipe(
      Effect.provide(
        buildLayer({
          backupFailWith: new BackupError({
            reason: "not_writable",
            detail: "open failed: EACCES on /backups/.probe-xyz"
          })
        })
      )
    )
  )
})

describe("Task 10: rehearsal readiness", () => {
  it.effect("passed=true の rehearsal が 1 件でもあれば rehearsal=pass", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      expect(findCheck(checks, "rehearsal").status).toBe("pass")
    }).pipe(Effect.provide(buildLayer()))
  )

  it.effect("rehearsal 0 件なら rehearsal=fail (start required)", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      expect(findCheck(checks, "rehearsal").status).toBe("fail")
    }).pipe(Effect.provide(buildLayer({ benchJobs: [] })))
  )

  it.effect("finished でも passed=false は rehearsal 実績にならない", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      expect(findCheck(checks, "rehearsal").status).toBe("fail")
    }).pipe(
      Effect.provide(
        buildLayer({
          benchJobs: [
            makeBenchJob({
              id: BenchJobId.make("bench-rehearsal-fail"),
              contestId: CONTEST_ID,
              teamId: TEAM1_ID,
              targetIp: "10.100.1.11",
              status: "finished",
              purpose: "rehearsal",
              passed: Option.some(false),
              score: Option.some(0),
              enqueuedAt: 1,
              startedAt: Option.some(2),
              finishedAt: Option.some(3)
            })
          ]
        })
      )
    )
  )
})

describe("previous_cleanup", () => {
  it.effect("finished contest に status != deleted の Instance が残っていれば fail", () =>
    Effect.gen(function* () {
      const legacyContestId = ContestId.make("c-edition1")
      const legacyTeamId = TeamId.make("t-legacy")
      const legacy = makeContest({ id: legacyContestId, edition: 1, status: "finished", revision: 1 })
      const legacyTeam = makeTeam({
        id: legacyTeamId,
        contestId: legacyContestId,
        teamNumber: 1,
        name: "team1"
      })
      // failed 状態でも vmid を保持しているため previous_cleanup は fail。
      // (idx_instances_vmid_active の判定と一致)
      const failedInstance = makeInstance({
        id: InstanceId.make("i-legacy"),
        teamId: legacyTeamId,
        contestId: legacyContestId,
        index: 1,
        vmid: 1101,
        privateIp: "10.100.1.11",
        status: "failed"
      })
      const checks = yield* computeReadiness(CONTEST_ID)
      expect(findCheck(checks, "previous_cleanup").status).toBe("fail")
    }).pipe(
      Effect.provide(
        buildLayer({
          contests: [
            preparingContest,
            makeContest({ id: ContestId.make("c-edition1"), edition: 1, status: "finished", revision: 1 })
          ],
          teams: [team1, makeTeam({ id: TeamId.make("t-legacy"), contestId: ContestId.make("c-edition1"), teamNumber: 1, name: "team1" })],
          instances: [
            makeInstance({
              id: InstanceId.make("i-legacy"),
              teamId: TeamId.make("t-legacy"),
              contestId: ContestId.make("c-edition1"),
              index: 1,
              vmid: 1101,
              privateIp: "10.100.1.11",
              status: "failed"
            })
          ]
        })
      )
    )
  )

  it.effect("canceled contest に active Instance が残っていれば fail", () =>
    Effect.gen(function* () {
      const canceledId = ContestId.make("c-canceled")
      const canceledTeamId = TeamId.make("t-canceled")
      const checks = yield* computeReadiness(CONTEST_ID).pipe(
        Effect.provide(
          buildLayer({
            contests: [
              preparingContest,
              makeContest({ id: canceledId, edition: 3, status: "canceled", revision: 1 })
            ],
            teams: [team1, makeTeam({ id: canceledTeamId, contestId: canceledId, teamNumber: 1, name: "team1" })],
            instances: [
              makeInstance({
                id: InstanceId.make("i-canceled"),
                teamId: canceledTeamId,
                contestId: canceledId,
                index: 1,
                vmid: 1101,
                privateIp: "10.100.1.11",
                status: "creating"
              })
            ]
          })
        )
      )
      expect(findCheck(checks, "previous_cleanup").status).toBe("fail")
    })
  )

  it.effect("finished/canceled contest の Instance がすべて deleted なら pass", () =>
    Effect.gen(function* () {
      const legacyContestId = ContestId.make("c-edition1")
      const legacyTeamId = TeamId.make("t-legacy")
      const checks = yield* computeReadiness(CONTEST_ID).pipe(
        Effect.provide(
          buildLayer({
            contests: [
              preparingContest,
              makeContest({ id: legacyContestId, edition: 1, status: "finished", revision: 1 })
            ],
            teams: [team1, makeTeam({ id: legacyTeamId, contestId: legacyContestId, teamNumber: 1, name: "team1" })],
            instances: [
              makeInstance({
                id: InstanceId.make("i-legacy-deleted"),
                teamId: legacyTeamId,
                contestId: legacyContestId,
                index: 1,
                vmid: 1101,
                privateIp: "10.100.1.11",
                status: "deleted"
              })
            ]
          })
        )
      )
      expect(findCheck(checks, "previous_cleanup").status).toBe("pass")
    })
  )
})

describe("Proxmox infrastructure inventory", () => {
  it.effect("inventory 取得失敗は template / team_slots / memory / benchvm / mode_vm_identity を fail、isolation を warn に落とす", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      for (const k of ["template", "team_slots", "memory", "benchvm", "mode_vm_identity"]) {
        expect(findCheck(checks, k).status).toBe("fail")
      }
      // isolation は「観測不能」であって「分離が壊れている」ではないので warn。
      expect(findCheck(checks, "isolation").status).toBe("warn")
    }).pipe(
      Effect.provide(
        buildLayer({
          proxmoxFail: {
            failWith: { getInfrastructureInventory: new ProxmoxError({ cause: "provider outage" }) }
          }
        })
      )
    )
  )

  // D1 回帰 (application 層): isolation の sub-request だけが取得不能になっても、
  // 他の Proxmox 依存 check は有効値を返す。本番で 1 本の HTTP 400 が 6 check を
  // 道連れにした事故の再発防止。
  it.effect("isolation だけが観測不能なら isolation=warn、他の Proxmox check は有効値のまま", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      const isolation = findCheck(checks, "isolation")
      expect(isolation.status).toBe("warn")
      expect(isolation.summary).toContain("systemctl is-active inucon-team-isolation")
      for (const k of ["template", "team_slots", "memory", "benchvm", "mode_vm_identity"]) {
        expect(findCheck(checks, k).status).toBe("pass")
      }
    }).pipe(
      Effect.provide(
        buildLayer({ proxmoxInventory: { ...healthyInventory, isolationServiceActive: null } })
      )
    )
  )

  it.effect("isolation は observable でないので start required key には含まれない", () => {
    expect(START_REQUIRED_CHECK_KEYS).not.toContain("isolation")
    return Effect.void
  })

  it.effect("template が存在しなければ template=fail、team_slots/isolation は独立に判定される", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      expect(findCheck(checks, "template").status).toBe("fail")
      expect(findCheck(checks, "team_slots").status).toBe("pass")
      expect(findCheck(checks, "isolation").status).toBe("pass")
    }).pipe(
      Effect.provide(
        buildLayer({ proxmoxInventory: { ...healthyInventory, templateExists: false } })
      )
    )
  )

  it.effect("必要 team slot (team1/team2) が preparedTeamNumbers に無ければ team_slots=fail", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      expect(findCheck(checks, "team_slots").status).toBe("fail")
    }).pipe(
      Effect.provide(
        buildLayer({ proxmoxInventory: { ...healthyInventory, preparedTeamNumbers: [1] } })
      )
    )
  )

  it.effect("isolation service が active でなければ isolation=fail", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      expect(findCheck(checks, "isolation").status).toBe("fail")
    }).pipe(
      Effect.provide(
        buildLayer({ proxmoxInventory: { ...healthyInventory, isolationServiceActive: false } })
      )
    )
  )

  it.effect("devvm shutdown 後の予想 MemAvailable が benchvm config + 1GiB reserve に満たなければ memory=fail", () =>
    Effect.gen(function* () {
      // node free 2 GiB + devvm 1 GiB = 3 GiB; benchvm 4 GiB + reserve 1 GiB = 5 GiB → fail
      const checks = yield* computeReadiness(CONTEST_ID)
      expect(findCheck(checks, "memory").status).toBe("fail")
    }).pipe(
      Effect.provide(
        buildLayer({
          proxmoxInventory: {
            ...healthyInventory,
            nodeFreeMemBytes: 2 * 1024 * 1024 * 1024,
            devvm: { ...healthyInventory.devvm, memoryBytes: 1 * 1024 * 1024 * 1024 },
            benchvm: { ...healthyInventory.benchvm, memoryBytes: 4 * 1024 * 1024 * 1024 }
          }
        })
      )
    )
  )

  it.effect("capacity_estimate は post-switch 見積もりで超過すれば warn(fail ではない)", () =>
    Effect.gen(function* () {
      // memory は OK だが desired 3 台 × 4 GiB = 12 GiB は post-shutdown ノード RAM を超える設定。
      // memory 自体は benchvm 起動可否だけを厳格判定するので pass に留め、capacity_estimate だけを warn にする。
      const inventory = {
        ...healthyInventory,
        // node free 6 GiB + devvm 8 GiB = 14 GiB shutdown 後
        nodeFreeMemBytes: 6 * 1024 * 1024 * 1024
      }
      const checks = yield* computeReadiness(CONTEST_ID).pipe(
        Effect.provide(buildLayer({ proxmoxInventory: inventory }))
      )
      expect(findCheck(checks, "memory").status).toBe("pass")
      expect(findCheck(checks, "capacity_estimate").status).toBe("warn")
    })
  )

  // production を壊した実バグ: 定数側の 9200/9300 が実機と逆だった。VMID 決め打ち
  // を observed name で裏取りし、不一致なら start を gate する (eevee-mode.sh と
  // 同じ fail-closed 思想)。
  it.effect("mode VM の observed name が期待値と一致すれば mode_vm_identity=pass", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      expect(findCheck(checks, "mode_vm_identity").status).toBe("pass")
    }).pipe(Effect.provide(buildLayer()))
  )

  it.effect("devvm/benchvm の名前が入れ替わっていれば mode_vm_identity=fail", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      const check = findCheck(checks, "mode_vm_identity")
      expect(check.status).toBe("fail")
      expect(check.summary).toBe(
        "VMID mapping mismatch: VM 9300 is named 'benchvm', expected 'devvm'; " +
          "verify /vms mapping before any power operation"
      )
    }).pipe(
      Effect.provide(
        buildLayer({
          proxmoxInventory: {
            ...healthyInventory,
            devvm: { ...healthyInventory.devvm, name: "benchvm" },
            benchvm: { ...healthyInventory.benchvm, name: "devvm" }
          }
        })
      )
    )
  )

  it.effect("benchvm 側だけ名前がズレていても mode_vm_identity=fail", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      const check = findCheck(checks, "mode_vm_identity")
      expect(check.status).toBe("fail")
      expect(check.summary).toBe(
        "VMID mapping mismatch: VM 9200 is named 'vaporeon', expected 'benchvm'; " +
          "verify /vms mapping before any power operation"
      )
    }).pipe(
      Effect.provide(
        buildLayer({
          proxmoxInventory: {
            ...healthyInventory,
            benchvm: { ...healthyInventory.benchvm, name: "vaporeon" }
          }
        })
      )
    )
  )
})

describe("Cloudflare probe", () => {
  it.effect("Cloudflare probe が失敗すると cloudflare_token=fail", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      expect(findCheck(checks, "cloudflare_token").status).toBe("fail")
    }).pipe(
      Effect.provide(
        buildLayer({
          cloudflareFail: {
            failWith: { probe: new CloudflareError({ cause: "token expired" }) }
          }
        })
      )
    )
  )

  it.effect("getInstanceInventory が失敗すると cloudflare_inventory=fail", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      expect(findCheck(checks, "cloudflare_inventory").status).toBe("fail")
    }).pipe(
      Effect.provide(
        buildLayer({
          cloudflareFail: {
            failWith: { getInstanceInventory: new CloudflareError({ cause: "inventory outage" }) }
          }
        })
      )
    )
  )
})

describe("readiness は provider 状態を一切 mutate しない", () => {
  it.effect("readiness 呼び出し後、Proxmox / Cloudflare のいずれも mutation は記録されない", () =>
    Effect.gen(function* () {
      const proxmox = makeProxmoxPortTest({
        infrastructureInventory: healthyInventory
      })
      const cloudflare = makeCloudflarePortTest({})
      yield* computeReadiness(CONTEST_ID).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeContestRepoTest([preparingContest]),
            makeInstanceRepoTest([]),
            makeTeamRepoTest({ teams: [team1], memberships: [] }),
            makeResourceBindingRepoTest([]),
            makeBenchJobRepoTest([]),
            makeRunnerAgentRepoTest([]),
            makeBackupPortTest(),
            RunnerConfigTest(600_000, 60_000),
            proxmox.layer,
            cloudflare.layer
          )
        )
      )
      const px = yield* proxmox.getState
      const cf = yield* cloudflare.getState
      expect(px.startedVmids).toEqual([])
      expect(px.destroyedVmids).toEqual([])
      expect(px.configuredVmids).toEqual([])
      expect(px.clonedVmids).toEqual([])
      expect(cf.accessEmailsByHostname).toEqual({})
      expect(cf.routesByHostname).toEqual({})
    })
  )
})
