import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import {
  CloudflareError,
  ProxmoxError
} from "../../src/application/ports.js"
import type { ProxmoxInfrastructureInventory } from "../../src/application/ports.js"
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
  ProxmoxTestOptions
} from "../support/inMemory.js"
import {
  makeCloudflarePortTest,
  makeContestRepoTest,
  makeInstanceRepoTest,
  makeProxmoxPortTest,
  makeResourceBindingRepoTest,
  makeTeamRepoTest
} from "../support/inMemory.js"

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
  devvm: { vmid: 9200, name: "devvm", status: "running" as const, memoryBytes: 8 * 1024 * 1024 * 1024, onBoot: true },
  benchvm: { vmid: 9300, name: "benchvm", status: "stopped" as const, memoryBytes: 4 * 1024 * 1024 * 1024, onBoot: false },
  preparedTeamNumbers: [1, 2] as ReadonlyArray<number>,
  isolationServiceActive: true
}

interface ReadinessLayerOptions {
  readonly contests?: ReadonlyArray<Contest>
  readonly instances?: ReadonlyArray<Instance>
  readonly teams?: ReadonlyArray<Team>
  readonly bindings?: ReadonlyArray<ResourceBinding>
  readonly proxmoxInventory?: ProxmoxInfrastructureInventory
  readonly proxmoxFail?: ProxmoxTestOptions
  readonly cloudflareInventory?: CloudflareInventorySeed
  readonly cloudflareFail?: CloudflareTestOptions
}

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
  return Layer.mergeAll(
    makeContestRepoTest(contests),
    makeInstanceRepoTest(instances),
    makeTeamRepoTest({ teams, memberships: [] }),
    // Task 9: readiness の cloudflare_write_proven key は ResourceBindingRepo を舐める。
    makeResourceBindingRepoTest(opts.bindings ?? []),
    proxmox,
    cloudflare
  )
}

describe("computeReadiness の必須 key set", () => {
  it.effect("healthy な状態では start required key がすべて pass、warn-until-later は warn を返す", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      // 少なくとも仕様に列挙された stable key を返す(順序は問わない)。
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
      // Task 10/11 未実装は warn。
      for (const k of ["cloudflare_write_proven", "runner", "backup", "rehearsal"]) {
        expect(findCheck(checks, k).status).toBe("warn")
      }
    }).pipe(Effect.provide(buildLayer()))
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
  it.effect("inventory 取得失敗は template / team_slots / isolation / memory / benchvm を fail に落とす", () =>
    Effect.gen(function* () {
      const checks = yield* computeReadiness(CONTEST_ID)
      for (const k of ["template", "team_slots", "isolation", "memory", "benchvm"]) {
        expect(findCheck(checks, k).status).toBe("fail")
      }
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
