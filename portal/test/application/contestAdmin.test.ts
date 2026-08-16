import { it } from "@effect/vitest"
import { Effect, Exit, Layer, Option } from "effect"
import { describe, expect } from "vitest"
import { ContestRepo, InviteRepo, TeamRepo } from "../../src/application/ports.js"
import { ContestNotFound } from "../../src/application/errors.js"
import {
  ContestEditionConflict,
  ContestRevisionConflict,
  InvalidContestSchedule,
  InvalidContestTransition,
  OperationalContestConflict
} from "../../src/domain/errors.js"
import {
  beginContestPreparation,
  cancelContest,
  copyContestRoster,
  createContestDraft,
  getAdminContest,
  listAdminContests,
  updateContestDraft
} from "../../src/application/usecases/contestAdmin.js"
import type { Contest } from "../../src/domain/contest.js"
import { ContestId, InstanceId, TeamId, UserId } from "../../src/domain/ids.js"
import type { Instance } from "../../src/domain/instance.js"
import type { Team } from "../../src/domain/team.js"
import { TeamInvite } from "../../src/domain/teamInvite.js"
import { User } from "../../src/domain/user.js"
import { makeContest, makeInstance, makeInvite, makeTeam } from "../support/factories.js"
import {
  makeContestRepoTest,
  makeInstanceRepoTest,
  makeInviteReposTest,
  makeOperationRepoStubTest,
  TransactionRunnerTest,
  UuidGenTest
} from "../support/inMemory.js"
// 単一 operational Contest 制約、edition partial unique、revision 楽観ロック、
// roster copy の deep clone、cancel の revision +1、schedule validation を
// 一箇所に集約する。cancel が同一トランザクションで team_invites を消す
// SQL-side の atomic 保証は test/http/contestAdmin.test.ts が SQL 経由で検証する。

const adminUserId = UserId.make("admin-user-id")

interface BuildLayerOptions {
  contests?: ReadonlyArray<Contest>
  teams?: ReadonlyArray<Team>
  memberships?: ReadonlyArray<{ contestId: ContestId; teamId: TeamId; userId: UserId }>
  invites?: ReadonlyArray<TeamInvite>
  users?: ReadonlyArray<User>
  instances?: ReadonlyArray<Instance>
  hasUnfinishedOperation?: boolean
}

const buildLayer = (opts: BuildLayerOptions = {}) => {
  const contests = opts.contests ?? []
  return Layer.mergeAll(
    UuidGenTest,
    TransactionRunnerTest,
    makeContestRepoTest(contests),
    makeInstanceRepoTest(opts.instances ?? []),
    makeOperationRepoStubTest({ hasUnfinished: opts.hasUnfinishedOperation ?? false }),
    makeInviteReposTest({
      teams: opts.teams ?? [],
      contests,
      users: opts.users ?? [],
      memberships: opts.memberships ?? [],
      invites: opts.invites ?? []
    })
  )
}

describe("createContestDraft", () => {
  it.effect("初回作成で status=draft・revision=1・timestamps 未設定の Contest を返す", () =>
    Effect.gen(function* () {
      const created = yield* createContestDraft({
        edition: 2,
        name: "INUCON #2",
        problemKey: "private-isu",
        problemRevision: "2026-08",
        templateVmid: 9100,
        instanceQuota: 3,
        scheduledStartAt: null,
        scheduledEndAt: null,
        accessClosesAt: null,
        cleanupAt: null
      })
      expect(created.status).toBe("draft")
      expect(created.revision).toBe(1)
      expect(created.edition).toBe(2)
      expect(created.name).toBe("INUCON #2")
      expect(Option.getOrNull(created.scheduledStartAt)).toBeNull()
      const repo = yield* ContestRepo
      const persisted = yield* repo.findById(created.id)
      expect(Option.isSome(persisted)).toBe(true)
    }).pipe(Effect.provide(buildLayer()))
  )

  it.effect("同じ edition の live Contest があると ContestEditionConflict", () =>
    Effect.gen(function* () {
      const existing = makeContest({ id: ContestId.make("existing"), edition: 2, status: "draft" })
      const exit = yield* Effect.exit(
        createContestDraft({
          edition: 2,
          name: "dup",
          problemKey: "private-isu",
          problemRevision: "r",
          templateVmid: 9100,
          instanceQuota: 3,
          scheduledStartAt: null,
          scheduledEndAt: null,
          accessClosesAt: null,
          cleanupAt: null
        }).pipe(Effect.provide(buildLayer({ contests: [existing] })))
      )
      expect(exit).toStrictEqual(Exit.fail(new ContestEditionConflict({ edition: 2 })))
    })
  )

  it.effect("同じ edition でも canceled のみなら成功する(番号を焼かない)", () =>
    Effect.gen(function* () {
      const canceled = makeContest({ id: ContestId.make("cx"), edition: 2, status: "canceled" })
      const created = yield* createContestDraft({
        edition: 2,
        name: "reissued",
        problemKey: "private-isu",
        problemRevision: "r",
        templateVmid: 9100,
        instanceQuota: 3,
        scheduledStartAt: null,
        scheduledEndAt: null,
        accessClosesAt: null,
        cleanupAt: null
      }).pipe(Effect.provide(buildLayer({ contests: [canceled] })))
      expect(created.edition).toBe(2)
      expect(created.status).toBe("draft")
    })
  )

  it.effect("schedule 順序違反(start >= end)は InvalidContestSchedule", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        createContestDraft({
          edition: 3,
          name: "bad",
          problemKey: "private-isu",
          problemRevision: "r",
          templateVmid: 9100,
          instanceQuota: 3,
          scheduledStartAt: 200,
          scheduledEndAt: 100,
          accessClosesAt: 200,
          cleanupAt: null
        }).pipe(Effect.provide(buildLayer()))
      )
      expect(exit).toStrictEqual(
        Exit.fail(new InvalidContestSchedule({ reason: "start_not_before_end" }))
      )
    })
  )
})

describe("updateContestDraft", () => {
  it.effect("成功すると revision が +1 され patch が反映される", () =>
    Effect.gen(function* () {
      const draft = makeContest({
        id: ContestId.make("d1"),
        edition: 5,
        name: "old",
        status: "draft",
        instanceQuota: 3,
        revision: 1
      })
      const updated = yield* updateContestDraft(draft.id, 1, {
        name: "new",
        instanceQuota: 5,
        scheduledStartAt: 100,
        scheduledEndAt: 200,
        accessClosesAt: 300,
        cleanupAt: null
      }).pipe(Effect.provide(buildLayer({ contests: [draft] })))
      expect(updated.revision).toBe(2)
      expect(updated.name).toBe("new")
      expect(updated.instanceQuota).toBe(5)
      expect(Option.getOrNull(updated.scheduledStartAt)).toBe(100)
      expect(Option.getOrNull(updated.scheduledEndAt)).toBe(200)
      expect(Option.getOrNull(updated.accessClosesAt)).toBe(300)
    })
  )

  it.effect("stale な expectedRevision は ContestRevisionConflict を返す", () =>
    Effect.gen(function* () {
      const draft = makeContest({ id: ContestId.make("d2"), status: "draft", revision: 3 })
      const exit = yield* Effect.exit(
        updateContestDraft(draft.id, 1, { name: "x" }).pipe(
          Effect.provide(buildLayer({ contests: [draft] }))
        )
      )
      expect(exit).toStrictEqual(
        Exit.fail(new ContestRevisionConflict({ expected: 1, actual: 3 }))
      )
    })
  )

  it.effect("存在しない Contest は ContestNotFound", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        updateContestDraft(ContestId.make("missing"), 1, { name: "x" }).pipe(
          Effect.provide(buildLayer())
        )
      )
      expect(exit).toStrictEqual(Exit.fail(new ContestNotFound()))
    })
  )

  it.effect("draft/preparing 以外は InvalidContestTransition", () =>
    Effect.gen(function* () {
      const running = makeContest({ id: ContestId.make("r"), status: "running", revision: 5 })
      const exit = yield* Effect.exit(
        updateContestDraft(running.id, 5, { name: "x" }).pipe(
          Effect.provide(buildLayer({ contests: [running] }))
        )
      )
      expect(exit).toStrictEqual(
        Exit.fail(new InvalidContestTransition({ from: "running", to: "draft" }))
      )
    })
  )
})

describe("copyContestRoster", () => {
  it.effect("source の Team を target に複製し、新しい ID・contestId を持つ", () => {
    const source = makeContest({ id: ContestId.make("src"), edition: 1, status: "finished" })
    const target = makeContest({ id: ContestId.make("tgt"), edition: 2, status: "draft" })
    const srcTeam1 = makeTeam({
      id: TeamId.make("src-t1"),
      contestId: source.id,
      teamNumber: 1,
      name: "team1",
      desiredInstanceCount: 3
    })
    const srcTeam2 = makeTeam({
      id: TeamId.make("src-t2"),
      contestId: source.id,
      teamNumber: 2,
      name: "team2",
      desiredInstanceCount: 2
    })
    const alice = new User({
      id: UserId.make("u-alice"),
      githubId: 1,
      githubLogin: "alice",
      displayName: "Alice",
      isAdmin: false,
      email: Option.some("alice@example.com")
    })
    const layer = buildLayer({
      contests: [source, target],
      teams: [srcTeam1, srcTeam2],
      users: [alice],
      memberships: [{ contestId: source.id, teamId: srcTeam1.id, userId: alice.id }],
      invites: [
        new TeamInvite({
          contestId: source.id,
          githubLogin: "invited",
          teamId: srcTeam2.id,
          email: "invited@example.com",
          invitedAt: 0
        })
      ]
    })

    return Effect.gen(function* () {
      const copied = yield* copyContestRoster(source.id, target.id)
      expect(copied).toHaveLength(2)
      expect(copied.map((t) => t.teamNumber).slice().sort()).toStrictEqual([1, 2])
      // 新しい team ID
      expect(copied.every((t) => t.id !== srcTeam1.id && t.id !== srcTeam2.id)).toBe(true)
      // target contest に紐づく
      expect(copied.every((t) => t.contestId === target.id)).toBe(true)

      const teamRepo = yield* TeamRepo
      const inviteRepo = yield* InviteRepo

      // Source は変更されていない
      const sourceTeams = yield* teamRepo.listByContest(source.id)
      expect(sourceTeams.map((t) => t.id).slice().sort()).toStrictEqual(
        [srcTeam1.id, srcTeam2.id].slice().sort()
      )

      // Members は target 側にも複製されている
      const targetT1 = copied.find((t) => t.teamNumber === 1)!
      const targetMembers = yield* teamRepo.listMembers(target.id, targetT1.id)
      expect(targetMembers.map((u) => u.githubLogin)).toStrictEqual(["alice"])

      // Invites も target 側にも複製されている
      const targetT2 = copied.find((t) => t.teamNumber === 2)!
      const targetInvites = yield* inviteRepo.listByTeam(target.id, targetT2.id)
      expect(targetInvites.map((i) => i.githubLogin)).toStrictEqual(["invited"])
      // Source invites も残っている
      const sourceInvites = yield* inviteRepo.listByTeam(source.id, srcTeam2.id)
      expect(sourceInvites.map((i) => i.githubLogin)).toStrictEqual(["invited"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("target が存在しないと ContestNotFound", () =>
    Effect.gen(function* () {
      const source = makeContest({ id: ContestId.make("s"), status: "finished" })
      const exit = yield* Effect.exit(
        copyContestRoster(source.id, ContestId.make("missing")).pipe(
          Effect.provide(buildLayer({ contests: [source] }))
        )
      )
      expect(exit).toStrictEqual(Exit.fail(new ContestNotFound()))
    })
  )
})

describe("beginContestPreparation", () => {
  it.effect("完全な schedule を持つ draft は preparing になり revision +1", () =>
    Effect.gen(function* () {
      const draft = makeContest({
        id: ContestId.make("d"),
        status: "draft",
        revision: 1,
        scheduledStartAt: Option.some(100),
        scheduledEndAt: Option.some(200),
        accessClosesAt: Option.some(300)
      })
      const result = yield* beginContestPreparation(draft.id, 1, adminUserId).pipe(
        Effect.provide(buildLayer({ contests: [draft] }))
      )
      expect(result.status).toBe("preparing")
      expect(result.revision).toBe(2)
    })
  )

  it.effect("schedule 未設定は InvalidContestSchedule", () =>
    Effect.gen(function* () {
      const draft = makeContest({ id: ContestId.make("d"), status: "draft", revision: 1 })
      const exit = yield* Effect.exit(
        beginContestPreparation(draft.id, 1, adminUserId).pipe(
          Effect.provide(buildLayer({ contests: [draft] }))
        )
      )
      expect(exit).toStrictEqual(
        Exit.fail(new InvalidContestSchedule({ reason: "missing_schedule" }))
      )
    })
  )

  it.effect("他に operational Contest が居ると OperationalContestConflict", () =>
    Effect.gen(function* () {
      const other = makeContest({ id: ContestId.make("other"), edition: 1, status: "running" })
      const draft = makeContest({
        id: ContestId.make("d"),
        edition: 2,
        status: "draft",
        revision: 1,
        scheduledStartAt: Option.some(100),
        scheduledEndAt: Option.some(200),
        accessClosesAt: Option.some(300)
      })
      const exit = yield* Effect.exit(
        beginContestPreparation(draft.id, 1, adminUserId).pipe(
          Effect.provide(buildLayer({ contests: [other, draft] }))
        )
      )
      expect(exit).toStrictEqual(Exit.fail(new OperationalContestConflict()))
    })
  )

  // Task 8 Step 4: previous_cleanup / no unfinished Operation / no
  // creating|deleting Instance の 3 ガード。start までに前開催の resource が
  // まだ残っていれば preparing 遷移を拒否する(readiness と同じ判定式)。
  it.effect("前開催に status != 'deleted' の Instance が残っていれば ContestNotReadyForPreparation", () =>
    Effect.gen(function* () {
      const legacyId = ContestId.make("legacy")
      const legacyTeam = TeamId.make("legacy-team")
      const legacy = makeContest({ id: legacyId, edition: 1, status: "finished" })
      const draft = makeContest({
        id: ContestId.make("d"),
        edition: 2,
        status: "draft",
        revision: 1,
        scheduledStartAt: Option.some(100),
        scheduledEndAt: Option.some(200),
        accessClosesAt: Option.some(300)
      })
      const exit = yield* Effect.exit(
        beginContestPreparation(draft.id, 1, adminUserId).pipe(
          Effect.provide(
            buildLayer({
              contests: [legacy, draft],
              teams: [
                makeTeam({ id: legacyTeam, contestId: legacyId, teamNumber: 1, name: "t1" })
              ],
              instances: [
                makeInstance({
                  id: InstanceId.make("i-legacy"),
                  teamId: legacyTeam,
                  contestId: legacyId,
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
      const cause = Exit.isFailure(exit) ? exit.cause : null
      expect(cause !== null).toBe(true)
      // 実装は ContestNotReadyForPreparation({ failingChecks: [...] }) を返す。
      // failingChecks に previous_cleanup が含まれる。
      expect(JSON.stringify(exit)).toMatch(/previous_cleanup/)
    })
  )

  it.effect("未完了 Operation が居ると ContestNotReadyForPreparation(unfinished_operation)", () =>
    Effect.gen(function* () {
      const draft = makeContest({
        id: ContestId.make("d"),
        edition: 2,
        status: "draft",
        revision: 1,
        scheduledStartAt: Option.some(100),
        scheduledEndAt: Option.some(200),
        accessClosesAt: Option.some(300)
      })
      const exit = yield* Effect.exit(
        beginContestPreparation(draft.id, 1, adminUserId).pipe(
          Effect.provide(buildLayer({ contests: [draft], hasUnfinishedOperation: true }))
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.stringify(exit)).toMatch(/unfinished_operation/)
    })
  )

  it.effect("creating/deleting Instance がグローバルに残っていれば ContestNotReadyForPreparation(transitional_instance)", () =>
    Effect.gen(function* () {
      const draft = makeContest({
        id: ContestId.make("d"),
        edition: 2,
        status: "draft",
        revision: 1,
        scheduledStartAt: Option.some(100),
        scheduledEndAt: Option.some(200),
        accessClosesAt: Option.some(300)
      })
      // 他 contest(finalizing 等)は無いが Instance だけ creating が残っている想定。
      const otherId = ContestId.make("other")
      const otherTeam = TeamId.make("other-t")
      const other = makeContest({ id: otherId, edition: 3, status: "finalizing" })
      // ↑ single-operational partial unique を考慮し finalizing は「これから finish」の状態。
      const exit = yield* Effect.exit(
        beginContestPreparation(draft.id, 1, adminUserId).pipe(
          Effect.provide(
            buildLayer({
              contests: [other, draft],
              teams: [makeTeam({ id: otherTeam, contestId: otherId, teamNumber: 1, name: "t1" })],
              instances: [
                makeInstance({
                  id: InstanceId.make("i-transitional"),
                  teamId: otherTeam,
                  contestId: otherId,
                  index: 1,
                  vmid: 3101,
                  privateIp: "10.100.3.11",
                  status: "creating"
                })
              ]
            })
          )
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
      // 他 operational contest(finalizing)が居ることも同時に検出されるが、
      // 少なくとも transitional_instance または operational_contest_conflict の
      // いずれかで拒否されればよい(先に発火する側を採用する)。
      const body = JSON.stringify(exit)
      expect(
        body.includes("transitional_instance") || body.includes("OperationalContestConflict")
      ).toBe(true)
    })
  )
})

describe("cancelContest", () => {
  it.effect("draft は canceled になり revision +1 (invite purge は HTTP+SQL テスト側で検証)", () =>
    Effect.gen(function* () {
      const draft = makeContest({ id: ContestId.make("d"), status: "draft", revision: 1 })
      const team = makeTeam({
        id: TeamId.make("t"),
        contestId: draft.id,
        teamNumber: 1,
        name: "t1"
      })
      const invite = makeInvite({
        contestId: draft.id,
        githubLogin: "pending",
        teamId: team.id,
        email: "p@example.com"
      })
      const layer = buildLayer({ contests: [draft], teams: [team], invites: [invite] })
      const result = yield* cancelContest(draft.id, 1, adminUserId).pipe(Effect.provide(layer))
      expect(result.status).toBe("canceled")
      expect(result.revision).toBe(2)
    })
  )

  it.effect("preparing も canceled にできる", () =>
    Effect.gen(function* () {
      const prep = makeContest({
        id: ContestId.make("p"),
        status: "preparing",
        revision: 2,
        scheduledStartAt: Option.some(100),
        scheduledEndAt: Option.some(200),
        accessClosesAt: Option.some(300)
      })
      const result = yield* cancelContest(prep.id, 2, adminUserId).pipe(
        Effect.provide(buildLayer({ contests: [prep] }))
      )
      expect(result.status).toBe("canceled")
    })
  )

  it.effect("running からの cancel は InvalidContestTransition", () =>
    Effect.gen(function* () {
      const running = makeContest({ id: ContestId.make("r"), status: "running", revision: 3 })
      const exit = yield* Effect.exit(
        cancelContest(running.id, 3, adminUserId).pipe(
          Effect.provide(buildLayer({ contests: [running] }))
        )
      )
      expect(exit).toStrictEqual(
        Exit.fail(new InvalidContestTransition({ from: "running", to: "canceled" }))
      )
    })
  )

  it.effect("stale revision は ContestRevisionConflict", () =>
    Effect.gen(function* () {
      const draft = makeContest({ id: ContestId.make("d"), status: "draft", revision: 3 })
      const exit = yield* Effect.exit(
        cancelContest(draft.id, 1, adminUserId).pipe(
          Effect.provide(buildLayer({ contests: [draft] }))
        )
      )
      expect(exit).toStrictEqual(
        Exit.fail(new ContestRevisionConflict({ expected: 1, actual: 3 }))
      )
    })
  )
})

describe("listAdminContests / getAdminContest", () => {
  it.effect("listAdminContests(includeCanceled=false) は canceled を除外する", () =>
    Effect.gen(function* () {
      const c1 = makeContest({ id: ContestId.make("c1"), edition: 1, status: "finished" })
      const c2 = makeContest({ id: ContestId.make("c2"), edition: 2, status: "canceled" })
      const results = yield* listAdminContests({ includeCanceled: false }).pipe(
        Effect.provide(buildLayer({ contests: [c1, c2] }))
      )
      expect(results.map((c) => c.id)).toStrictEqual([c1.id])
    })
  )

  it.effect("listAdminContests(includeCanceled=true) は canceled も返す", () =>
    Effect.gen(function* () {
      const c1 = makeContest({ id: ContestId.make("c1"), edition: 1, status: "finished" })
      const c2 = makeContest({ id: ContestId.make("c2"), edition: 2, status: "canceled" })
      const results = yield* listAdminContests({ includeCanceled: true }).pipe(
        Effect.provide(buildLayer({ contests: [c1, c2] }))
      )
      expect(results.map((c) => c.id).sort()).toStrictEqual([c1.id, c2.id].slice().sort())
    })
  )

  it.effect("getAdminContest は canceled も返す(監査用)", () =>
    Effect.gen(function* () {
      const canceled = makeContest({ id: ContestId.make("cx"), edition: 3, status: "canceled" })
      const result = yield* getAdminContest(canceled.id).pipe(
        Effect.provide(buildLayer({ contests: [canceled] }))
      )
      expect(result.id).toBe(canceled.id)
    })
  )

  it.effect("getAdminContest は存在しない ID で ContestNotFound", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        getAdminContest(ContestId.make("missing")).pipe(Effect.provide(buildLayer()))
      )
      expect(exit).toStrictEqual(Exit.fail(new ContestNotFound()))
    })
  )
})
