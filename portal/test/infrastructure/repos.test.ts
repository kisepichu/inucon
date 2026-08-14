import { it } from "@effect/vitest"
import { Effect, Exit, Layer, Option } from "effect"
import { expect } from "vitest"
import { newJob } from "../../src/domain/benchJob.js"
import { Instance } from "../../src/domain/instance.js"
import { Team } from "../../src/domain/team.js"
import { User } from "../../src/domain/user.js"
import {
  CannotCancelRunning,
  DuplicateInstanceIndex,
  InvalidJobTransition,
  TeamJobAlreadyQueued
} from "../../src/domain/errors.js"
import { BenchJobId, ContestId, InstanceId, TeamId, UserId } from "../../src/domain/ids.js"
import { InstanceNotRunning } from "../../src/application/errors.js"
import {
  BenchJobRepo,
  ContestRepo,
  InstanceRepo,
  InviteRepo,
  SessionRepo,
  TeamRepo,
  UserRepo,
  UuidGen
} from "../../src/application/ports.js"
import { BenchJobRepoLive } from "../../src/infrastructure/sql/repos/benchJobRepo.js"
import { ContestRepoLive } from "../../src/infrastructure/sql/repos/contestRepo.js"
import { InstanceRepoLive } from "../../src/infrastructure/sql/repos/instanceRepo.js"
import { InviteRepoLive } from "../../src/infrastructure/sql/repos/inviteRepo.js"
import { SessionRepoLive } from "../../src/infrastructure/sql/repos/sessionRepo.js"
import { TeamRepoLive } from "../../src/infrastructure/sql/repos/teamRepo.js"
import { UserRepoLive } from "../../src/infrastructure/sql/repos/userRepo.js"
import { UuidGenLive } from "../../src/infrastructure/sql/uuid.js"
import { MigratorTest, SqlTest } from "../support/sqlTest.js"
import {
  DEFAULT_TEST_CONTEST_ID,
  makeBenchJob,
  makeContest,
  makeInstance,
  makeInvite,
  makeTeam
} from "../support/factories.js"

// `:memory:` SQLite + 本番と同一マイグレーションを適用した Layer。it.layer(...)
// の呼び出し単位(= 下の each `layer("...", ...)` ブロック単位)で独立した
// DB がビルドされるため、テストデータの ID はブロック内でのみユニークであれば
// 良い。UserRepoLive は UuidGen に依存するが Layer.mergeAll は兄弟レイヤー
// 同士の依存を自動解決しないため、Layer.provideMerge(UuidGenLive) で
// UuidGenLive を 1 回だけ構築し、それを他レイヤーの依存解決に使いつつ
// 結果にも公開する(UuidGenLive を mergeAll のリストにも含めて
// Layer.provide すると 2 インスタンスになってしまうため避ける)。
const RepoLayer = Layer.mergeAll(
  ContestRepoLive,
  UserRepoLive,
  SessionRepoLive,
  TeamRepoLive,
  InstanceRepoLive,
  BenchJobRepoLive,
  InviteRepoLive
).pipe(Layer.provideMerge(UuidGenLive), Layer.provideMerge(MigratorTest), Layer.provideMerge(SqlTest))

const layer = it.layer(RepoLayer)

// Task 3: 全 scoped 集約(teams/instances/bench_jobs)は contest_id を持つ必要が
// あるため、layer ブロックごとに operational な contest を最初に create する。
// operational な contest を idempotent に用意する。1 つの layer(...) 内で
// 複数の it.effect が同じ :memory: DB を共有するため、既に存在していれば
// 何もしない(2 回目以降の it.effect は同じ contest を継続して使う)。
const seedContest = (status: "preparing" | "running" = "preparing") =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const existing = yield* contests.getOperational
    if (Option.isSome(existing)) return
    yield* contests.create(makeContest({ id: DEFAULT_TEST_CONTEST_ID, status }))
  })

layer("ContestRepo", (it) => {
  it.effect("getOperational: 未 create なら None、create 後は取得できる", () =>
    Effect.gen(function* () {
      const repo = yield* ContestRepo
      const before = yield* repo.getOperational
      expect(before).toStrictEqual(Option.none())

      const contest = makeContest({ id: DEFAULT_TEST_CONTEST_ID, status: "preparing", name: "INUCON", problemKey: "problem-1" })
      yield* repo.create(contest)
      const after = yield* repo.getOperational
      expect(after).toStrictEqual(Option.some(contest))
    })
  )

  it.effect("saveIfRevision は revision 一致で置き換える", () =>
    Effect.gen(function* () {
      const repo = yield* ContestRepo
      // 前 it.effect と DB を共有するため、edition/ id を分けて衝突を避ける。
      const contestId = ContestId.make("00000000-0000-0000-0000-cccccccccccd")
      const first = makeContest({ id: contestId, edition: 2, status: "draft", name: "A", problemKey: "p1", revision: 1 })
      yield* repo.create(first)
      const next = makeContest({ ...first, name: "B", problemKey: "p2", revision: 2 })
      const saved = yield* repo.saveIfRevision(next, 1)
      expect(saved).toStrictEqual(next)
      const found = yield* repo.findById(contestId)
      expect(found).toStrictEqual(Option.some(next))
    })
  )
})

layer("UserRepo", (it) => {
  it.effect("upsertByGithub: 新規作成 → 同じ githubId で再度呼ぶと更新される", () =>
    Effect.gen(function* () {
      const repo = yield* UserRepo
      const created = yield* repo.upsertByGithub({
        githubId: 1001,
        githubLogin: "octocat",
        displayName: "Octo Cat",
        isAdmin: false
      })
      expect(created.githubLogin).toBe("octocat")
      expect(created.isAdmin).toBe(false)

      const updated = yield* repo.upsertByGithub({
        githubId: 1001,
        githubLogin: "octocat2",
        displayName: "Octo Cat 2",
        isAdmin: true
      })
      // id は変わらず、内容だけ更新される
      expect(updated.id).toBe(created.id)
      expect(updated.githubLogin).toBe("octocat2")
      expect(updated.isAdmin).toBe(true)

      const found = yield* repo.findById(created.id)
      expect(found).toStrictEqual(Option.some(updated))
    })
  )

  it.effect("findById: 存在しない id は None", () =>
    Effect.gen(function* () {
      const repo = yield* UserRepo
      const result = yield* repo.findById(UserId.make("nonexistent-user"))
      expect(result).toStrictEqual(Option.none())
    })
  )
})

layer("SessionRepo", (it) => {
  it.effect("findValidUser: 有効なセッションなら User が取れる、期限切れなら None", () =>
    Effect.gen(function* () {
      const users = yield* UserRepo
      const sessions = yield* SessionRepo
      const user = yield* users.upsertByGithub({
        githubId: 2001,
        githubLogin: "sessuser",
        displayName: "Sess User",
        isAdmin: false
      })

      const validSessionId = yield* sessions.create(user.id, 10_000)
      const found = yield* sessions.findValidUser(validSessionId, 5_000)
      expect(found).toStrictEqual(Option.some(user))

      const expiredSessionId = yield* sessions.create(user.id, 1_000)
      const notFound = yield* sessions.findValidUser(expiredSessionId, 5_000)
      expect(notFound).toStrictEqual(Option.none())
    })
  )

  it.effect("delete: 削除後は findValidUser が None を返す", () =>
    Effect.gen(function* () {
      const users = yield* UserRepo
      const sessions = yield* SessionRepo
      const user = yield* users.upsertByGithub({
        githubId: 2002,
        githubLogin: "sessuser2",
        displayName: "Sess User 2",
        isAdmin: false
      })
      const sessionId = yield* sessions.create(user.id, 10_000)
      yield* sessions.delete(sessionId)
      const result = yield* sessions.findValidUser(sessionId, 0)
      expect(result).toStrictEqual(Option.none())
    })
  )
})

layer("TeamRepo", (it) => {
  it.effect("create/list/findById/setMembers/listMembers", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const users = yield* UserRepo

      const team = makeTeam({ id: TeamId.make("team-repo-1"), name: "Team Repo 1", teamNumber: 101 })
      yield* teams.create(team)

      const all = yield* teams.listByContest(DEFAULT_TEST_CONTEST_ID)
      expect(all.some((t) => t.id === team.id)).toBe(true)

      const found = yield* teams.findById(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(found).toStrictEqual(Option.some(team))

      const user = yield* users.upsertByGithub({
        githubId: 3001,
        githubLogin: "teamuser",
        displayName: "Team User",
        isAdmin: false
      })
      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, team.id, [user.id])

      const byUser = yield* teams.findByUserId(DEFAULT_TEST_CONTEST_ID, user.id)
      expect(byUser).toStrictEqual(Option.some(team))

      const members = yield* teams.listMembers(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(members).toStrictEqual([user])
    })
  )
})

layer("TeamRepo: setMembers 複数行 INSERT", (it) => {
  it.effect("2人を一度に set すると listMembers が2人返す", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const users = yield* UserRepo
      const team = makeTeam({ id: TeamId.make("team-members-multi"), name: "Members Multi", teamNumber: 211 })
      yield* teams.create(team)

      const user1 = yield* users.upsertByGithub({
        githubId: 9001,
        githubLogin: "multiuser1",
        displayName: "Multi User 1",
        isAdmin: false
      })
      const user2 = yield* users.upsertByGithub({
        githubId: 9002,
        githubLogin: "multiuser2",
        displayName: "Multi User 2",
        isAdmin: false
      })

      yield* teams.setMembers(DEFAULT_TEST_CONTEST_ID, team.id, [user1.id, user2.id])

      const members = yield* teams.listMembers(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(
        members.map((m) => m.id).slice().sort()
      ).toStrictEqual([user1.id, user2.id].slice().sort())
    })
  )
})

layer("TeamRepo: addMember", (it) => {
  it.effect("未所属ユーザーへの addMember は true を返し、実際にそのチームへ追加する", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const users = yield* UserRepo
      const team = makeTeam({ id: TeamId.make("team-addmember-1"), name: "Add Member 1", teamNumber: 221 })
      yield* teams.create(team)

      const user = yield* users.upsertByGithub({
        githubId: 9101,
        githubLogin: "addmemberuser1",
        displayName: "Add Member User 1",
        isAdmin: false
      })

      const added = yield* teams.addMember(DEFAULT_TEST_CONTEST_ID, team.id, user.id)
      expect(added).toBe(true)

      const found = yield* teams.findByUserId(DEFAULT_TEST_CONTEST_ID, user.id)
      expect(found).toStrictEqual(Option.some(team))
    })
  )

  it.effect("既に何らかのチームに所属済みのユーザーへの addMember は false を返し、所属を変えない(TOCTOU 回避)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const users = yield* UserRepo
      const teamA = makeTeam({ id: TeamId.make("team-addmember-a"), name: "Add Member A", teamNumber: 222 })
      const teamB = makeTeam({ id: TeamId.make("team-addmember-b"), name: "Add Member B", teamNumber: 223 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      const user = yield* users.upsertByGithub({
        githubId: 9102,
        githubLogin: "addmemberuser2",
        displayName: "Add Member User 2",
        isAdmin: false
      })

      const firstAdd = yield* teams.addMember(DEFAULT_TEST_CONTEST_ID, teamA.id, user.id)
      expect(firstAdd).toBe(true)

      // 既に teamA 所属。同じチームへの再追加も、別チームへの追加試行も
      // false(=このコールでは追加できなかった)を返し、所属は変わらない。
      const reAddSameTeam = yield* teams.addMember(DEFAULT_TEST_CONTEST_ID, teamA.id, user.id)
      expect(reAddSameTeam).toBe(false)

      const addDifferentTeam = yield* teams.addMember(DEFAULT_TEST_CONTEST_ID, teamB.id, user.id)
      expect(addDifferentTeam).toBe(false)

      const found = yield* teams.findByUserId(DEFAULT_TEST_CONTEST_ID, user.id)
      expect(found).toStrictEqual(Option.some(teamA))
    })
  )
})

layer("InstanceRepo", (it) => {
  it.effect("create/listByTeam/remove", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo

      const team = makeTeam({ id: TeamId.make("team-repo-instances"), name: "Instances Team", teamNumber: 102 })
      yield* teams.create(team)

      const instance = makeInstance({
        id: InstanceId.make("instance-1"),
        teamId: team.id,
        index: 1,
        vmid: 1102,
        privateIp: "10.100.102.10",
        status: "running",
        progress: ["clone_done", "configured", "started", "route_done", "access_done"],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      const created = yield* instances.create(instance)
      expect(created).toStrictEqual(instance)

      const listed = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(listed).toStrictEqual([instance])

      yield* instances.remove(instance.id)
      const afterRemove = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(afterRemove).toStrictEqual([])
    })
  )
})

layer("InstanceRepo: create 重複拒否", (it) => {
  it.effect("同一 (team, index) の二重 create は DuplicateInstanceIndex", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = makeTeam({ id: TeamId.make("team-repo-instances-dup"), name: "Instances Dup", teamNumber: 103 })
      yield* teams.create(team)

      const first = makeInstance({
        id: InstanceId.make("instance-dup-1"),
        teamId: team.id,
        index: 1,
        vmid: 1103,
        privateIp: "10.100.103.10",
        status: "running",
        progress: ["clone_done", "configured", "started", "route_done", "access_done"],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      yield* instances.create(first)

      const second = makeInstance({
        id: InstanceId.make("instance-dup-2"),
        teamId: team.id,
        index: 1,
        vmid: 1103,
        privateIp: "10.100.103.11",
        status: "running",
        progress: ["clone_done", "configured", "started", "route_done", "access_done"],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      const exit = yield* Effect.exit(instances.create(second))
      expect(exit).toStrictEqual(Exit.fail(new DuplicateInstanceIndex({ teamId: team.id, index: 1 })))

      // 拒否された行は挿入されていない(元の1件のみ残る)
      const listed = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(listed).toStrictEqual([first])
    })
  )

  it.effect("deleted 行がある idx は再作成できる(部分ユニークインデックス)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = makeTeam({ id: TeamId.make("team-repo-idx-reuse"), name: "Idx Reuse", teamNumber: 104 })
      yield* teams.create(team)

      // idx=1 を deleted 状態で登録(過去に使って撤収済みの想定)
      const old = makeInstance({
        id: InstanceId.make("instance-reuse-old"),
        teamId: team.id,
        index: 1,
        vmid: 1104,
        privateIp: "10.100.104.11",
        status: "deleted",
        progress: [],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      yield* instances.create(old)

      // 同 idx=1 を新規 creating で作れる(deleted は部分ユニークの対象外)
      const fresh = makeInstance({
        id: InstanceId.make("instance-reuse-new"),
        teamId: team.id,
        index: 1,
        vmid: 1104,
        privateIp: "10.100.104.11",
        status: "creating",
        progress: [],
        errorMessage: Option.none(),
        createdAt: 1,
        updatedAt: 1
      })
      const created = yield* instances.create(fresh)
      expect(created.id).toStrictEqual(fresh.id)
    })
  )

  // Task 6 レビュー #E: migration 0003 で部分ユニークインデックスの述語を
  // 「status != 'deleted'」に締め直した(failed も対象)。以前は failed 行が
  // あっても同じ idx へ新規 create できてしまい(#A のアプリ層 allocator の
  // 意図と食い違っていた)、vmid/IP 衝突や後述の 500 エラーの温床だった。
  it.effect("failed 行がある idx への新規 create は DuplicateInstanceIndex(Task 6 レビュー #E)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = makeTeam({
        id: TeamId.make("team-repo-idx-failed-dup"),
        name: "Idx Failed Dup",
        teamNumber: 105
      })
      yield* teams.create(team)

      // idx=1 が failed のまま(未掃除、VM/vmid をまだ握っている想定)
      const failed = makeInstance({
        id: InstanceId.make("instance-failed-dup-old"),
        teamId: team.id,
        index: 1,
        vmid: 1105,
        privateIp: "10.100.105.11",
        status: "failed",
        progress: [],
        errorMessage: Option.some("boom"),
        createdAt: 0,
        updatedAt: 0
      })
      yield* instances.create(failed)

      // 同 idx=1 への新規 create は許されない(以前は成功していた #A バグ)
      const colliding = makeInstance({
        id: InstanceId.make("instance-failed-dup-new"),
        teamId: team.id,
        index: 1,
        vmid: 1105,
        privateIp: "10.100.105.11",
        status: "running",
        progress: [],
        errorMessage: Option.none(),
        createdAt: 1,
        updatedAt: 1
      })
      const exit = yield* Effect.exit(instances.create(colliding))
      expect(exit).toStrictEqual(Exit.fail(new DuplicateInstanceIndex({ teamId: team.id, index: 1 })))

      // 拒否された行は挿入されていない(failed 行のみ残る)
      const listed = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(listed).toStrictEqual([failed])
    })
  )
})

layer("InstanceRepo: beginDeletingIfAllowed", (it) => {
  it.effect("running を deleting へ原子的に遷移させ、Some を返す(競合する行が無い場合)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = makeTeam({ id: TeamId.make("team-begindel-ok"), name: "BeginDel OK", teamNumber: 210 })
      yield* teams.create(team)

      const target = makeInstance({
        id: InstanceId.make("instance-begindel-ok"),
        teamId: team.id,
        index: 1,
        vmid: 1210,
        privateIp: "10.100.210.11",
        status: "running",
        progress: ["clone_done", "configured", "started", "route_done", "access_done"],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      yield* instances.create(target)

      const result = yield* instances.beginDeletingIfAllowed(target.id, 500)
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.status).toBe("deleting")
        expect(result.value.updatedAt).toBe(500)
      }

      const listed = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(listed.find((i) => i.id === target.id)?.status).toBe("deleting")
    })
  )

  it.effect("同チームに他の creating 行があれば None(対象は running のまま)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = makeTeam({ id: TeamId.make("team-begindel-creating"), name: "BeginDel Creating", teamNumber: 211 })
      yield* teams.create(team)

      const target = makeInstance({
        id: InstanceId.make("instance-begindel-creating-target"),
        teamId: team.id,
        index: 1,
        vmid: 1211,
        privateIp: "10.100.211.11",
        status: "running",
        progress: [],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      const other = makeInstance({
        id: InstanceId.make("instance-begindel-creating-other"),
        teamId: team.id,
        index: 2,
        vmid: 1212,
        privateIp: "10.100.211.12",
        status: "creating",
        progress: [],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      yield* instances.create(target)
      yield* instances.create(other)

      const result = yield* instances.beginDeletingIfAllowed(target.id, 500)
      expect(result).toStrictEqual(Option.none())

      const listed = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(listed.find((i) => i.id === target.id)?.status).toBe("running")
    })
  )

  it.effect("同チームに他の deleting 行があれば None(対象は running のまま)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = makeTeam({ id: TeamId.make("team-begindel-deleting"), name: "BeginDel Deleting", teamNumber: 212 })
      yield* teams.create(team)

      const target = makeInstance({
        id: InstanceId.make("instance-begindel-deleting-target"),
        teamId: team.id,
        index: 1,
        vmid: 1213,
        privateIp: "10.100.212.11",
        status: "running",
        progress: [],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      const other = makeInstance({
        id: InstanceId.make("instance-begindel-deleting-other"),
        teamId: team.id,
        index: 2,
        vmid: 1214,
        privateIp: "10.100.212.12",
        status: "deleting",
        progress: [],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      yield* instances.create(target)
      yield* instances.create(other)

      const result = yield* instances.beginDeletingIfAllowed(target.id, 500)
      expect(result).toStrictEqual(Option.none())

      const listed = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(listed.find((i) => i.id === target.id)?.status).toBe("running")
    })
  )

  it.effect("対象が creating(running/failed でない)なら None(状態を変えない)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = makeTeam({ id: TeamId.make("team-begindel-notarget"), name: "BeginDel NoTarget", teamNumber: 213 })
      yield* teams.create(team)

      const target = makeInstance({
        id: InstanceId.make("instance-begindel-notarget"),
        teamId: team.id,
        index: 1,
        vmid: 1215,
        privateIp: "10.100.213.11",
        status: "creating",
        progress: [],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      yield* instances.create(target)

      const result = yield* instances.beginDeletingIfAllowed(target.id, 500)
      expect(result).toStrictEqual(Option.none())

      const listed = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(listed.find((i) => i.id === target.id)?.status).toBe("creating")
    })
  )

  // Task 6 レビュー #E 確認: この UPDATE は自分自身(同一 id)の行を書き換える
  // だけで新しい行を挿入するわけではないため、migration 0003 で failed も
  // 部分ユニークインデックスの対象(status != 'deleted')に含めても、他に
  // 同じ idx を持つ行が無ければこの遷移は問題なく成功し続ける
  // (「failed 行の通常の自己サービス削除」経路は壊れない)。
  it.effect("failed からも deleting へ遷移できる(Task 4 レビュー I4)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = makeTeam({ id: TeamId.make("team-begindel-failed"), name: "BeginDel Failed", teamNumber: 214 })
      yield* teams.create(team)

      const target = makeInstance({
        id: InstanceId.make("instance-begindel-failed"),
        teamId: team.id,
        index: 1,
        vmid: 1216,
        privateIp: "10.100.214.11",
        status: "failed",
        progress: [],
        errorMessage: Option.some("boom"),
        createdAt: 0,
        updatedAt: 0
      })
      yield* instances.create(target)

      const result = yield* instances.beginDeletingIfAllowed(target.id, 500)
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.status).toBe("deleting")
      }
    })
  )

  // Task 6 レビュー #D: 削除とベンチ enqueue のクロス集約 TOCTOU 修正。対象の
  // private_ip を targetIp とする queued/running な bench_jobs があれば、
  // 事前チェックを経ずにこのアトミック UPDATE 自体が拒否する(呼び出し元の
  // 事前 listByTeam チェックが無くても不変条件4を守れることを直接確認する)。
  it.effect("対象 IP を targetIp とする queued な bench_job があれば None(状態を変えない)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({ id: TeamId.make("team-begindel-benchinuse"), name: "BeginDel BenchInUse", teamNumber: 215 })
      yield* teams.create(team)

      const target = makeInstance({
        id: InstanceId.make("instance-begindel-benchinuse"),
        teamId: team.id,
        index: 1,
        vmid: 1217,
        privateIp: "10.100.215.11",
        status: "running",
        progress: [],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      yield* instances.create(target)
      yield* jobs.insertIfAllowed(
        newJob({
          contestId: DEFAULT_TEST_CONTEST_ID,
          purpose: "competition",
          id: BenchJobId.make("job-begindel-benchinuse"),
          teamId: team.id,
          targetIp: target.privateIp,
          targetPort: 80,
          now: 0
        })
      )

      const result = yield* instances.beginDeletingIfAllowed(target.id, 500)
      expect(result).toStrictEqual(Option.none())

      const listed = yield* instances.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id)
      expect(listed.find((i) => i.id === target.id)?.status).toBe("running")
    })
  )

  it.effect("対象 IP を targetIp とする bench_job が無ければ Some(従来どおり成功する)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({ id: TeamId.make("team-begindel-benchfree"), name: "BeginDel BenchFree", teamNumber: 216 })
      yield* teams.create(team)

      const target = makeInstance({
        id: InstanceId.make("instance-begindel-benchfree"),
        teamId: team.id,
        index: 1,
        vmid: 1218,
        privateIp: "10.100.216.11",
        status: "running",
        progress: [],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      yield* instances.create(target)
      // 別インスタンスの IP を対象にした job は無関係(混入しないことも確認)。
      yield* jobs.insertIfAllowed(
        newJob({
          contestId: DEFAULT_TEST_CONTEST_ID,
          purpose: "competition",
          id: BenchJobId.make("job-begindel-benchfree-other"),
          teamId: team.id,
          targetIp: "10.100.216.99",
          targetPort: 80,
          now: 0
        })
      )

      const result = yield* instances.beginDeletingIfAllowed(target.id, 500)
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.status).toBe("deleting")
      }
    })
  )
})

// BenchJobRepo は「全体で running は同時に 1 本まで」というテーブル全体に
// わたる不変条件を持つため、シナリオ同士が同じ DB を共有すると前のテストが
// 残した queued/running 行が後続の dequeue 判定に混入してしまう。そのため
// 1 シナリオ = 1 個の layer(...) 呼び出し(= 独立した :memory: DB)に分ける。
layer("BenchJobRepo: insertIfAllowed 重複拒否", (it) => {
  it.effect("同チームに queued/running があれば TeamJobAlreadyQueued", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({ id: TeamId.make("team-bj-dup"), name: "BJ Dup", teamNumber: 111 })
      yield* teams.create(team)

      const job1 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-dup-1"),
        teamId: team.id,
        targetIp: "10.100.111.5",
        targetPort: 8080,
        now: 1000
      })
      const inserted = yield* jobs.insertIfAllowed(job1)
      expect(inserted).toStrictEqual(job1)

      const job2 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-dup-2"),
        teamId: team.id,
        targetIp: "10.100.111.6",
        targetPort: 8080,
        now: 2000
      })
      const exit = yield* Effect.exit(jobs.insertIfAllowed(job2))
      expect(exit).toStrictEqual(Exit.fail(new TeamJobAlreadyQueued({ teamId: team.id })))
    })
  )
})

// Task 6 レビュー #D: instanceId 起点の enqueue が渡す requireRunningInstance
// ガード。BenchJobRepo は「全体で running は同時に 1 本まで」という
// テーブル全体不変条件を持つため、他のシナリオと DB を共有しないよう
// 1 シナリオ = 1 個の layer(...) 呼び出しに分ける(既存の方針どおり)。
layer("BenchJobRepo: insertIfAllowed requireRunningInstance", (it) => {
  it.effect("対象 instance が running なら requireRunningInstance 付きでも挿入できる", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({ id: TeamId.make("team-bj-reqrun-ok"), name: "BJ ReqRun OK", teamNumber: 120 })
      yield* teams.create(team)
      const instance = makeInstance({
        id: InstanceId.make("instance-bj-reqrun-ok"),
        teamId: team.id,
        index: 1,
        vmid: 1120,
        privateIp: "10.100.120.11",
        status: "running",
        progress: [],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      yield* instances.create(instance)

      const job = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-reqrun-ok"),
        teamId: team.id,
        targetIp: instance.privateIp,
        targetPort: 80,
        now: 1000
      })
      const inserted = yield* jobs.insertIfAllowed(job, {
        instanceId: instance.id,
        teamId: team.id
      })
      expect(inserted).toStrictEqual(job)
    })
  )

  // Task 6 レビュー #H: team_id + private_ip だけの照合は緩すぎる。対象
  // instance 自身は running でなくなっていても、同じ team・同じ private_ip を
  // 持つ「別の」running 行がたまたま存在すると誤って通ってしまうバグの回帰
  // テスト。ここでは対象(deleting)とは別の instance を同じ team・同じ
  // private_ip で running のまま作り、id 照合であれば対象行の状態だけで
  // 判定されて拒否される(team+IP 照合だと誤って通ってしまう)ことを示す。
  it.effect(
    "同じ team+private_ip の別 instance が running でも、対象 instance 自身が running でなければ拒否される(id 照合)",
    () =>
      Effect.gen(function* () {
        yield* seedContest()
        const teams = yield* TeamRepo
        const instances = yield* InstanceRepo
        const jobs = yield* BenchJobRepo
        const team = makeTeam({
          id: TeamId.make("team-bj-reqrun-idmatch"),
          name: "BJ ReqRun IdMatch",
          teamNumber: 126
        })
        yield* teams.create(team)

        // 対象 instance: deleting(running ではない)。
        const target = makeInstance({
          id: InstanceId.make("instance-bj-reqrun-idmatch-target"),
          teamId: team.id,
          index: 1,
          vmid: 1126,
          privateIp: "10.100.126.11",
          status: "deleting",
          progress: [],
          errorMessage: Option.none(),
          createdAt: 0,
          updatedAt: 0
        })
        yield* instances.create(target)

        // 同じ team・同じ private_ip を持つ別の running instance(スロット
        // 再利用や admin 台帳取り込みの重複 IP を模した defensive なケース、
        // (team_id, idx) の一意性は idx が異なるので破らない)。
        const other = makeInstance({
          id: InstanceId.make("instance-bj-reqrun-idmatch-other"),
          teamId: team.id,
          index: 2,
          vmid: 1127,
          privateIp: target.privateIp,
          status: "running",
          progress: [],
          errorMessage: Option.none(),
          createdAt: 0,
          updatedAt: 0
        })
        yield* instances.create(other)

        const job = newJob({
          contestId: DEFAULT_TEST_CONTEST_ID,
          purpose: "competition",
          id: BenchJobId.make("bj-reqrun-idmatch"),
          teamId: team.id,
          targetIp: target.privateIp,
          targetPort: 80,
          now: 1000
        })
        const exit = yield* Effect.exit(
          jobs.insertIfAllowed(job, { instanceId: target.id, teamId: team.id })
        )
        expect(exit).toStrictEqual(Exit.fail(new InstanceNotRunning({ instanceId: target.id })))

        const listed = yield* jobs.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id, 50)
        expect(listed).toHaveLength(0)
      })
  )

  // テーブル駆動: running 以外の状態(削除進行中・削除済み・失敗)のいずれでも
  // requireRunningInstance ガードが 0 行挿入にし、team のキュー不変条件が
  // 原因でない(= 他に queued/running が無い)ため InstanceNotRunning に
  // 分類されることを確認する。
  const REQRUN_STATUS_TEAM_NUMBERS = { deleting: 121, deleted: 122, failed: 123 } as const
  for (const status of ["deleting", "deleted", "failed"] as const) {
    it.effect(`対象 instance が ${status} なら InstanceNotRunning(挿入されない)`, () =>
      Effect.gen(function* () {
        yield* seedContest()
        const teams = yield* TeamRepo
        const instances = yield* InstanceRepo
        const jobs = yield* BenchJobRepo
        const team = makeTeam({
          id: TeamId.make(`team-bj-reqrun-${status}`),
          name: `BJ ReqRun ${status}`,
          teamNumber: REQRUN_STATUS_TEAM_NUMBERS[status]
        })
        yield* teams.create(team)
        const instance = makeInstance({
          id: InstanceId.make(`instance-bj-reqrun-${status}`),
          teamId: team.id,
          index: 1,
          vmid: 1120 + REQRUN_STATUS_TEAM_NUMBERS[status],
          privateIp: `10.100.${REQRUN_STATUS_TEAM_NUMBERS[status]}.11`,
          status,
          progress: [],
          errorMessage: status === "failed" ? Option.some("boom") : Option.none()
        })
        yield* instances.create(instance)

        const job = newJob({
          contestId: DEFAULT_TEST_CONTEST_ID,
          purpose: "competition",
          id: BenchJobId.make(`bj-reqrun-${status}`),
          teamId: team.id,
          targetIp: instance.privateIp,
          targetPort: 80,
          now: 1000
        })
        const exit = yield* Effect.exit(
          jobs.insertIfAllowed(job, { instanceId: instance.id, teamId: team.id })
        )
        expect(exit).toStrictEqual(Exit.fail(new InstanceNotRunning({ instanceId: instance.id })))

        // 挿入されていないことも確認する(ジョブ枠を浪費しない)。
        const listed = yield* jobs.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id, 50)
        expect(listed).toHaveLength(0)
      })
    )
  }

  it.effect(
    "team に既に queued/running があれば instance が running でも TeamJobAlreadyQueued が優先される",
    () =>
      Effect.gen(function* () {
        yield* seedContest()
        const teams = yield* TeamRepo
        const instances = yield* InstanceRepo
        const jobs = yield* BenchJobRepo
        const team = makeTeam({ id: TeamId.make("team-bj-reqrun-priority"), name: "BJ ReqRun Priority", teamNumber: 124 })
        yield* teams.create(team)
        const instance = makeInstance({
          id: InstanceId.make("instance-bj-reqrun-priority"),
          teamId: team.id,
          index: 1,
          vmid: 1122,
          privateIp: "10.100.122.11",
          status: "running",
          progress: [],
          errorMessage: Option.none(),
          createdAt: 0,
          updatedAt: 0
        })
        yield* instances.create(instance)

        const first = newJob({
          contestId: DEFAULT_TEST_CONTEST_ID,
          purpose: "competition",
          id: BenchJobId.make("bj-reqrun-priority-first"),
          teamId: team.id,
          targetIp: instance.privateIp,
          targetPort: 80,
          now: 1000
        })
        yield* jobs.insertIfAllowed(first)

        const second = newJob({
          contestId: DEFAULT_TEST_CONTEST_ID,
          purpose: "competition",
          id: BenchJobId.make("bj-reqrun-priority-second"),
          teamId: team.id,
          targetIp: instance.privateIp,
          targetPort: 80,
          now: 2000
        })
        const exit = yield* Effect.exit(
          jobs.insertIfAllowed(second, { instanceId: instance.id, teamId: team.id })
        )
        expect(exit).toStrictEqual(Exit.fail(new TeamJobAlreadyQueued({ teamId: team.id })))
      })
  )

  it.effect("requireRunningInstance 未指定(手動 IP:port)なら instance の状態に関係なく挿入できる", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({ id: TeamId.make("team-bj-reqrun-manual"), name: "BJ ReqRun Manual", teamNumber: 125 })
      yield* teams.create(team)
      // instance 行はあるが deleted(= 手動ターゲットが偶然同じ IP を指す
      // ケース)。requireRunningInstance を渡さないので instanceGuard は
      // WHERE に影響せず、team のキュー不変条件だけで判定される。
      const instance = makeInstance({
        id: InstanceId.make("instance-bj-reqrun-manual"),
        teamId: team.id,
        index: 1,
        vmid: 1123,
        privateIp: "10.100.123.11",
        status: "deleted",
        progress: [],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      yield* instances.create(instance)

      const job = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-reqrun-manual"),
        teamId: team.id,
        targetIp: instance.privateIp,
        targetPort: 8080,
        now: 1000
      })
      const inserted = yield* jobs.insertIfAllowed(job)
      expect(inserted).toStrictEqual(job)
    })
  )
})

// Task 6 レビュー #I: 直接 IP:port 指定(requireRunningInstance 未指定)の
// enqueue でも、targetIp が自チームの managed instance の private_ip と
// 一致し、かつその instance が creating/deleting(払い出し中/削除中)なら
// フォームに関わらず弾かれることを確認する universal ガードの回帰テスト。
layer("BenchJobRepo: insertIfAllowed 直接 IP 指定でも creating/deleting な managed instance を弾く(#I)", (it) => {
  for (const status of ["creating", "deleting"] as const) {
    it.effect(`targetIp が ${status} な managed instance の private_ip と一致すると InstanceNotRunning(挿入されない)`, () =>
      Effect.gen(function* () {
        yield* seedContest()
        const teams = yield* TeamRepo
        const instances = yield* InstanceRepo
        const jobs = yield* BenchJobRepo
        const team = makeTeam({
          id: TeamId.make(`team-bj-directip-${status}`),
          name: `BJ DirectIp ${status}`,
          teamNumber: status === "creating" ? 231 : 232
        })
        yield* teams.create(team)
        const instance = makeInstance({
          id: InstanceId.make(`instance-bj-directip-${status}`),
          teamId: team.id,
          index: 1,
          vmid: status === "creating" ? 1301 : 1302,
          privateIp: `10.100.${status === "creating" ? 231 : 232}.11`,
          status,
          progress: [],
          errorMessage: Option.none(),
          createdAt: 0,
          updatedAt: 0
        })
        yield* instances.create(instance)

        // instanceId は渡さない = 手動 IP:port 指定の直接フォーム。
        const job = newJob({
          contestId: DEFAULT_TEST_CONTEST_ID,
          purpose: "competition",
          id: BenchJobId.make(`bj-directip-${status}`),
          teamId: team.id,
          targetIp: instance.privateIp,
          targetPort: 80,
          now: 1000
        })
        const exit = yield* Effect.exit(jobs.insertIfAllowed(job))
        expect(exit).toStrictEqual(Exit.fail(new InstanceNotRunning({ instanceId: instance.id })))

        const listed = yield* jobs.listByTeam(DEFAULT_TEST_CONTEST_ID, team.id, 50)
        expect(listed).toHaveLength(0)
      })
    )
  }

  it.effect("targetIp が running な managed instance の private_ip と一致すれば直接 IP 指定でも成功する", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({ id: TeamId.make("team-bj-directip-running"), name: "BJ DirectIp Running", teamNumber: 233 })
      yield* teams.create(team)
      const instance = makeInstance({
        id: InstanceId.make("instance-bj-directip-running"),
        teamId: team.id,
        index: 1,
        vmid: 1303,
        privateIp: "10.100.233.11",
        status: "running",
        progress: [],
        errorMessage: Option.none(),
        createdAt: 0,
        updatedAt: 0
      })
      yield* instances.create(instance)

      const job = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-directip-running"),
        teamId: team.id,
        targetIp: instance.privateIp,
        targetPort: 80,
        now: 1000
      })
      const inserted = yield* jobs.insertIfAllowed(job)
      expect(inserted).toStrictEqual(job)
    })
  )

  it.effect("targetIp に対応する instance 行が無い(unmanaged)なら直接 IP 指定は従来どおり成功する", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({ id: TeamId.make("team-bj-directip-unmanaged"), name: "BJ DirectIp Unmanaged", teamNumber: 234 })
      yield* teams.create(team)

      const job = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-directip-unmanaged"),
        teamId: team.id,
        targetIp: "10.100.234.55",
        targetPort: 80,
        now: 1000
      })
      const inserted = yield* jobs.insertIfAllowed(job)
      expect(inserted).toStrictEqual(job)
    })
  )
})

layer("BenchJobRepo: appendLog", (it) => {
  it.effect("追記になる", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({ id: TeamId.make("team-bj-log"), name: "BJ Log", teamNumber: 112 })
      yield* teams.create(team)

      const job = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-log-1"),
        teamId: team.id,
        targetIp: "10.100.112.5",
        targetPort: 8080,
        now: 1000
      })
      yield* jobs.insertIfAllowed(job)

      const emptyLog = yield* jobs.getLog(job.id)
      expect(emptyLog).toBe("")

      yield* jobs.appendLog(job.id, "line1\n")
      yield* jobs.appendLog(job.id, "line2\n")
      const log = yield* jobs.getLog(job.id)
      expect(log).toBe("line1\nline2\n")
    })
  )
})

layer("BenchJobRepo: dequeueNextQueued", (it) => {
  it.effect("FIFO 順序、running 存在時は None", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const teamA = makeTeam({ id: TeamId.make("team-bj-fifo-a"), name: "FIFO A", teamNumber: 121 })
      const teamB = makeTeam({ id: TeamId.make("team-bj-fifo-b"), name: "FIFO B", teamNumber: 122 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      const jobA = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-fifo-a"),
        teamId: teamA.id,
        targetIp: "10.100.121.5",
        targetPort: 8080,
        now: 1000
      })
      const jobB = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-fifo-b"),
        teamId: teamB.id,
        targetIp: "10.100.122.5",
        targetPort: 8080,
        now: 2000
      })
      yield* jobs.insertIfAllowed(jobA)
      yield* jobs.insertIfAllowed(jobB)

      const first = yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 5000)
      expect(Option.isSome(first)).toBe(true)
      if (Option.isSome(first)) {
        expect(first.value.id).toBe(jobA.id)
        expect(first.value.status).toBe("running")
      }

      // まだ running が存在するので次の dequeue は None
      const second = yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 6000)
      expect(second).toStrictEqual(Option.none())
    })
  )
})

layer("BenchJobRepo: 状態遷移", (it) => {
  it.effect("recordProgressIfRunning/finishIfRunning/cancelIfQueued の正常系", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({ id: TeamId.make("team-bj-transitions"), name: "Transitions", teamNumber: 131 })
      yield* teams.create(team)

      const cancelTarget = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-cancel-1"),
        teamId: team.id,
        targetIp: "10.100.131.5",
        targetPort: 8080,
        now: 1000
      })
      yield* jobs.insertIfAllowed(cancelTarget)
      const canceled = yield* jobs.cancelIfQueued(cancelTarget.id)
      expect(canceled.status).toBe("canceled")

      const runTarget = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-run-1"),
        teamId: team.id,
        targetIp: "10.100.131.6",
        targetPort: 8080,
        now: 2000
      })
      yield* jobs.insertIfAllowed(runTarget)
      const running = yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 3000)
      expect(Option.isSome(running)).toBe(true)

      const progressed = yield* jobs.recordProgressIfRunning(runTarget.id, 4000)
      expect(Option.isSome(progressed.lastProgressAt)).toBe(true)
      if (Option.isSome(progressed.lastProgressAt)) {
        expect(progressed.lastProgressAt.value).toBe(4000)
      }

      const finished = yield* jobs.finishIfRunning(runTarget.id, { score: 42, passed: true }, 5000)
      expect(finished.status).toBe("finished")
      expect(finished.score).toStrictEqual(Option.some(42))
      expect(finished.passed).toStrictEqual(Option.some(true))
    })
  )
})

layer("BenchJobRepo: failTimedOutJobs", (it) => {
  it.effect("finish 済みジョブを上書きしない(競合回帰)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({ id: TeamId.make("team-bj-sweep"), name: "Sweep", teamNumber: 141 })
      yield* teams.create(team)

      const job = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-sweep-1"),
        teamId: team.id,
        targetIp: "10.100.141.5",
        targetPort: 8080,
        now: 0
      })
      yield* jobs.insertIfAllowed(job)
      yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 0)

      // finish 済みにしてから sweep する。判定と更新が原子的でない実装だと
      // finished を failed で上書きしうる(TOCTOU)。
      const finished = yield* jobs.finishIfRunning(job.id, { score: 10, passed: true }, 100)
      expect(finished.status).toBe("finished")

      const count = yield* jobs.failTimedOutJobs(50, 999_999)
      expect(count).toBe(0)

      const after = yield* jobs.findById(job.id)
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) {
        expect(after.value.status).toBe("finished")
        expect(after.value.score).toStrictEqual(Option.some(10))
      }
    })
  )
})

layer("BenchJobRepo: scoreboard", (it) => {
  it.effect("best は MAX(score)、latest は finished_at 最大行の score、finished のみ集計", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const teamA = makeTeam({ id: TeamId.make("team-scoreboard-a"), name: "Scoreboard A", teamNumber: 151 })
      const teamB = makeTeam({ id: TeamId.make("team-scoreboard-b"), name: "Scoreboard B", teamNumber: 152 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      // teamA: finished(score=50, finishedAt=1000), finished(score=80, finishedAt=2000)
      //   → best=80, latest=80(finishedAt=2000 の行)
      const a1 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-sb-a1"),
        teamId: teamA.id,
        targetIp: "10.100.151.1",
        targetPort: 8080,
        now: 100
      })
      yield* jobs.insertIfAllowed(a1)
      yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 100)
      yield* jobs.finishIfRunning(a1.id, { score: 50, passed: true }, 1000)

      const a2 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-sb-a2"),
        teamId: teamA.id,
        targetIp: "10.100.151.2",
        targetPort: 8080,
        now: 1500
      })
      yield* jobs.insertIfAllowed(a2)
      yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 1500)
      yield* jobs.finishIfRunning(a2.id, { score: 80, passed: true }, 2000)

      // teamB: finished(score=99, finishedAt=500), canceled(集計対象外)
      const b1 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-sb-b1"),
        teamId: teamB.id,
        targetIp: "10.100.152.1",
        targetPort: 8080,
        now: 50
      })
      yield* jobs.insertIfAllowed(b1)
      yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 50)
      yield* jobs.finishIfRunning(b1.id, { score: 99, passed: false }, 500)

      const b2 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-sb-b2"),
        teamId: teamB.id,
        targetIp: "10.100.152.2",
        targetPort: 8080,
        now: 3000
      })
      yield* jobs.insertIfAllowed(b2)
      yield* jobs.cancelIfQueued(b2.id)

      const board = yield* jobs.scoreboard(DEFAULT_TEST_CONTEST_ID)
      const byId = new Map(board.map((row) => [row.teamId, row]))

      const rowA = byId.get(teamA.id)
      expect(rowA?.bestScore).toBe(80)
      expect(rowA?.latestScore).toBe(80)
      expect(rowA?.latestAt).toBe(2000)

      const rowB = byId.get(teamB.id)
      expect(rowB?.bestScore).toBe(99)
      expect(rowB?.latestScore).toBe(99)
      expect(rowB?.latestAt).toBe(500)

      // チーム全件を返す(チームが存在すれば finished が無くても行がある)
      const teamC = makeTeam({ id: TeamId.make("team-scoreboard-c"), name: "Scoreboard C", teamNumber: 153 })
      yield* teams.create(teamC)
      const boardWithC = yield* jobs.scoreboard(DEFAULT_TEST_CONTEST_ID)
      const rowC = boardWithC.find((row) => row.teamId === teamC.id)
      expect(rowC).toBeDefined()
      expect(rowC?.bestScore).toBeNull()
      expect(rowC?.latestScore).toBeNull()
      expect(rowC?.latestAt).toBeNull()
    })
  )
})

layer("BenchJobRepo: scoreboard の best と latest の取り違え検出", (it) => {
  it.effect("finished 2本(先: score=500 finishedAt=1000 / 後: score=300 finishedAt=2000) → best=500, latest=300", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({ id: TeamId.make("team-sb-bl"), name: "SB Best/Latest", teamNumber: 161 })
      yield* teams.create(team)

      const job1 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-sb-bl-1"),
        teamId: team.id,
        targetIp: "10.100.161.1",
        targetPort: 8080,
        now: 100
      })
      yield* jobs.insertIfAllowed(job1)
      yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 100)
      yield* jobs.finishIfRunning(job1.id, { score: 500, passed: true }, 1000)

      const job2 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-sb-bl-2"),
        teamId: team.id,
        targetIp: "10.100.161.2",
        targetPort: 8080,
        now: 1500
      })
      yield* jobs.insertIfAllowed(job2)
      yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 1500)
      yield* jobs.finishIfRunning(job2.id, { score: 300, passed: true }, 2000)

      const board = yield* jobs.scoreboard(DEFAULT_TEST_CONTEST_ID)
      const row = board.find((r) => r.teamId === team.id)
      // MAX(score) は 500(先の job1)、latest は finished_at 最大行(=後の job2)の
      // score である 300。best と latest を取り違えて両方 MAX(score) や両方
      // 最新行になっていないかを検出する。
      expect(row?.bestScore).toBe(500)
      expect(row?.latestScore).toBe(300)
      expect(row?.latestAt).toBe(2000)
    })
  )
})

layer("BenchJobRepo: scoreboard の finished_at 同値タイ", (it) => {
  it.effect("同一 finished_at の2本 → id DESC の行の score が latest になる", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({ id: TeamId.make("team-sb-tie"), name: "SB Tie", teamNumber: 191 })
      yield* teams.create(team)

      // "bj-sb-tie-2" > "bj-sb-tie-1" (文字列比較) なので id DESC では
      // job2 が先頭に来る。score をあえて best とは逆にして、latest が
      // score の大小ではなく id で決まっていることを検証する。
      const job1 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-sb-tie-1"),
        teamId: team.id,
        targetIp: "10.100.191.1",
        targetPort: 8080,
        now: 100
      })
      yield* jobs.insertIfAllowed(job1)
      yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 100)
      yield* jobs.finishIfRunning(job1.id, { score: 90, passed: true }, 5000)

      const job2 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-sb-tie-2"),
        teamId: team.id,
        targetIp: "10.100.191.2",
        targetPort: 8080,
        now: 1500
      })
      yield* jobs.insertIfAllowed(job2)
      yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 1500)
      yield* jobs.finishIfRunning(job2.id, { score: 10, passed: true }, 5000)

      const board = yield* jobs.scoreboard(DEFAULT_TEST_CONTEST_ID)
      const row = board.find((r) => r.teamId === team.id)
      expect(row?.bestScore).toBe(90)
      expect(row?.latestScore).toBe(10)
      expect(row?.latestAt).toBe(5000)
    })
  )
})

layer("BenchJobRepo: listByTeam", (it) => {
  it.effect("対象チームの分だけ enqueued_at 降順で limit 件を返す", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const teamA = makeTeam({ id: TeamId.make("team-list-a"), name: "List A", teamNumber: 181 })
      const teamB = makeTeam({ id: TeamId.make("team-list-b"), name: "List B", teamNumber: 182 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      // 同一チームは queued/running を同時に 1 本しか持てないため、都度
      // cancelIfQueued で退避させてから次を積む。
      const a1 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-list-a1"),
        teamId: teamA.id,
        targetIp: "10.100.181.1",
        targetPort: 8080,
        now: 100
      })
      yield* jobs.insertIfAllowed(a1)
      yield* jobs.cancelIfQueued(a1.id)

      const a2 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-list-a2"),
        teamId: teamA.id,
        targetIp: "10.100.181.2",
        targetPort: 8080,
        now: 200
      })
      yield* jobs.insertIfAllowed(a2)
      yield* jobs.cancelIfQueued(a2.id)

      const a3 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-list-a3"),
        teamId: teamA.id,
        targetIp: "10.100.181.3",
        targetPort: 8080,
        now: 300
      })
      yield* jobs.insertIfAllowed(a3)
      yield* jobs.cancelIfQueued(a3.id)

      const b1 = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-list-b1"),
        teamId: teamB.id,
        targetIp: "10.100.182.1",
        targetPort: 8080,
        now: 250
      })
      yield* jobs.insertIfAllowed(b1)

      const listedA = yield* jobs.listByTeam(DEFAULT_TEST_CONTEST_ID, teamA.id, 2)
      expect(listedA.map((j) => j.id)).toStrictEqual([a3.id, a2.id])

      const listedB = yield* jobs.listByTeam(DEFAULT_TEST_CONTEST_ID, teamB.id, 10)
      expect(listedB.map((j) => j.id)).toStrictEqual([b1.id])
    })
  )
})

layer("BenchJobRepo: dequeueNextQueued の同一 enqueued_at タイブレーク", (it) => {
  it.effect("id 昇順の方が先に出る(挿入順ではない)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const teamA = makeTeam({ id: TeamId.make("team-dq-tie-a"), name: "DQ Tie A", teamNumber: 201 })
      const teamB = makeTeam({ id: TeamId.make("team-dq-tie-b"), name: "DQ Tie B", teamNumber: 202 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      // id の大きい方 (z) を先に挿入し、あとから id の小さい方 (a) を挿入する。
      // enqueued_at が同値のとき挿入順ではなく id 昇順で先頭が決まることを検証する。
      const jobZ = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-dq-tie-z"),
        teamId: teamA.id,
        targetIp: "10.100.201.1",
        targetPort: 8080,
        now: 1000
      })
      yield* jobs.insertIfAllowed(jobZ)
      const jobA = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-dq-tie-a"),
        teamId: teamB.id,
        targetIp: "10.100.202.1",
        targetPort: 8080,
        now: 1000
      })
      yield* jobs.insertIfAllowed(jobA)

      const dequeued = yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 2000)
      expect(Option.isSome(dequeued)).toBe(true)
      if (Option.isSome(dequeued)) {
        expect(dequeued.value.id).toBe(jobA.id)
      }
    })
  )
})

layer("BenchJobRepo: finishIfRunning は queued ジョブに失敗する", (it) => {
  it.effect("InvalidJobTransition(from: queued, action: finish)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({
        id: TeamId.make("team-err-finish-queued"),
        name: "Err Finish Queued",
        teamNumber: 171
      })
      yield* teams.create(team)

      const job = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-err-finish-queued"),
        teamId: team.id,
        targetIp: "10.100.171.5",
        targetPort: 8080,
        now: 1000
      })
      yield* jobs.insertIfAllowed(job)

      const exit = yield* Effect.exit(jobs.finishIfRunning(job.id, { score: 1, passed: true }, 2000))
      expect(exit).toStrictEqual(
        Exit.fail(new InvalidJobTransition({ jobId: job.id, from: "queued", action: "finish" }))
      )
    })
  )
})

layer("BenchJobRepo: recordProgressIfRunning は queued ジョブに失敗する", (it) => {
  it.effect("InvalidJobTransition(from: queued, action: recordProgress)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({
        id: TeamId.make("team-err-progress-queued"),
        name: "Err Progress Queued",
        teamNumber: 172
      })
      yield* teams.create(team)

      const job = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-err-progress-queued"),
        teamId: team.id,
        targetIp: "10.100.172.5",
        targetPort: 8080,
        now: 1000
      })
      yield* jobs.insertIfAllowed(job)

      const exit = yield* Effect.exit(jobs.recordProgressIfRunning(job.id, 2000))
      expect(exit).toStrictEqual(
        Exit.fail(new InvalidJobTransition({ jobId: job.id, from: "queued", action: "recordProgress" }))
      )
    })
  )
})

layer("BenchJobRepo: cancelIfQueued は running ジョブに失敗する", (it) => {
  it.effect("CannotCancelRunning", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({
        id: TeamId.make("team-err-cancel-running"),
        name: "Err Cancel Running",
        teamNumber: 173
      })
      yield* teams.create(team)

      const job = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-err-cancel-running"),
        teamId: team.id,
        targetIp: "10.100.173.5",
        targetPort: 8080,
        now: 1000
      })
      yield* jobs.insertIfAllowed(job)
      yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 2000)

      const err = yield* Effect.flip(jobs.cancelIfQueued(job.id))
      expect(err).toStrictEqual(new CannotCancelRunning({ jobId: job.id }))
    })
  )
})

layer("BenchJobRepo: cancelIfQueued は finished ジョブに失敗する", (it) => {
  it.effect("InvalidJobTransition(from: finished, action: cancel)", () =>
    Effect.gen(function* () {
      yield* seedContest()
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = makeTeam({
        id: TeamId.make("team-err-cancel-finished"),
        name: "Err Cancel Finished",
        teamNumber: 174
      })
      yield* teams.create(team)

      const job = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-err-cancel-finished"),
        teamId: team.id,
        targetIp: "10.100.174.5",
        targetPort: 8080,
        now: 1000
      })
      yield* jobs.insertIfAllowed(job)
      yield* jobs.dequeueNextQueued({ contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" }, 2000)
      yield* jobs.finishIfRunning(job.id, { score: 1, passed: true }, 3000)

      const err = yield* Effect.flip(jobs.cancelIfQueued(job.id))
      expect(err).toStrictEqual(new InvalidJobTransition({ jobId: job.id, from: "finished", action: "cancel" }))
    })
  )
})

layer("UuidGenLive", (it) => {
  it.effect("next は毎回異なる UUID 形式の文字列を返す", () =>
    Effect.gen(function* () {
      const gen = yield* UuidGen
      const id1 = yield* gen.next
      const id2 = yield* gen.next
      expect(id1).not.toBe(id2)
      expect(id1).toMatch(/^[0-9a-f-]{36}$/)
    })
  )
})

// Task 3: purpose フィルタ (rehearsal vs competition) が dequeue で機能して
// いることを確認する。古い queued(rehearsal)を無視して新しい queued
// (competition)を選ぶ = FIFO のみでは説明できない挙動なので、フィルタ削除
// を検知するリグレッションテストとして意味を持つ。
layer("BenchJobRepo: dequeueNextQueued は purpose フィルタで competition を選ぶ", (it) => {
  it.effect("古い rehearsal をスキップして新しい competition を返す", () =>
    Effect.gen(function* () {
      yield* seedContest("running")
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const rehearsalTeam = makeTeam({ id: TeamId.make("team-purpose-reh"), name: "Rehearsal", teamNumber: 201 })
      const competitionTeam = makeTeam({ id: TeamId.make("team-purpose-com"), name: "Competition", teamNumber: 202 })
      yield* teams.create(rehearsalTeam)
      yield* teams.create(competitionTeam)

      // rehearsal は 1000、competition は 2000。FIFO のみなら rehearsal が
      // 先に選ばれるはずだが、purpose='competition' の dequeue は competition
      // を返さなければならない。
      const rehearsalJob = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "rehearsal",
        id: BenchJobId.make("bj-purpose-reh"),
        teamId: rehearsalTeam.id,
        targetIp: "10.100.201.5",
        targetPort: 8080,
        now: 1000
      })
      const competitionJob = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-purpose-com"),
        teamId: competitionTeam.id,
        targetIp: "10.100.202.5",
        targetPort: 8080,
        now: 2000
      })
      yield* jobs.insertIfAllowed(rehearsalJob)
      yield* jobs.insertIfAllowed(competitionJob)

      const picked = yield* jobs.dequeueNextQueued(
        { contestId: DEFAULT_TEST_CONTEST_ID, purpose: "competition" },
        5000
      )
      expect(Option.isSome(picked)).toBe(true)
      if (Option.isSome(picked)) {
        expect(picked.value.id).toBe(competitionJob.id)
        expect(picked.value.purpose).toBe("competition")
      }
    })
  )
})

layer("BenchJobRepo: dequeueNextQueued は purpose フィルタで rehearsal を選ぶ", (it) => {
  it.effect("古い competition をスキップして新しい rehearsal を返す", () =>
    Effect.gen(function* () {
      yield* seedContest("preparing")
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const competitionTeam = makeTeam({ id: TeamId.make("team-rev-com"), name: "CompetitionOlder", teamNumber: 211 })
      const rehearsalTeam = makeTeam({ id: TeamId.make("team-rev-reh"), name: "RehearsalNewer", teamNumber: 212 })
      yield* teams.create(competitionTeam)
      yield* teams.create(rehearsalTeam)

      const competitionJob = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "competition",
        id: BenchJobId.make("bj-rev-com"),
        teamId: competitionTeam.id,
        targetIp: "10.100.211.5",
        targetPort: 8080,
        now: 1000
      })
      const rehearsalJob = newJob({
        contestId: DEFAULT_TEST_CONTEST_ID,
        purpose: "rehearsal",
        id: BenchJobId.make("bj-rev-reh"),
        teamId: rehearsalTeam.id,
        targetIp: "10.100.212.5",
        targetPort: 8080,
        now: 2000
      })
      yield* jobs.insertIfAllowed(competitionJob)
      yield* jobs.insertIfAllowed(rehearsalJob)

      const picked = yield* jobs.dequeueNextQueued(
        { contestId: DEFAULT_TEST_CONTEST_ID, purpose: "rehearsal" },
        5000
      )
      expect(Option.isSome(picked)).toBe(true)
      if (Option.isSome(picked)) {
        expect(picked.value.id).toBe(rehearsalJob.id)
        expect(picked.value.purpose).toBe("rehearsal")
      }
    })
  )
})

// Task 3: contest_id フィルタが dequeue で機能していることを確認する。
// 別 contest に古い queued があっても、対象 contest の queued (新しい方) を
// 返す = FIFO のみでは説明できない挙動なので、フィルタ削除を検知する。
layer("BenchJobRepo: dequeueNextQueued は contest_id で絞る", (it) => {
  it.effect("別 contest の古い queued は候補にならない", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo

      // idx_contests_single_operational があるため operational は 1 つだけ。
      // targetContest を running にし、otherContest は draft で置く。
      const targetContestId = ContestId.make("00000000-0000-0000-0000-cccccccccce1")
      const otherContestId = ContestId.make("00000000-0000-0000-0000-cccccccccce2")
      yield* contests.create(makeContest({ id: targetContestId, edition: 11, status: "running" }))
      yield* contests.create(makeContest({ id: otherContestId, edition: 12, status: "draft" }))

      const otherTeam = makeTeam({
        id: TeamId.make("team-cross-other"),
        contestId: otherContestId,
        name: "OtherContestTeam",
        teamNumber: 221
      })
      const targetTeam = makeTeam({
        id: TeamId.make("team-cross-target"),
        contestId: targetContestId,
        name: "TargetContestTeam",
        teamNumber: 222
      })
      yield* teams.create(otherTeam)
      yield* teams.create(targetTeam)

      // 他 contest 側は 1000 (古い)、対象 contest 側は 2000 (新しい)。
      // FIFO のみなら other が先だが、contest フィルタは target を返さねばならない。
      const otherJob = newJob({
        contestId: otherContestId,
        purpose: "competition",
        id: BenchJobId.make("bj-cross-other"),
        teamId: otherTeam.id,
        targetIp: "10.100.221.5",
        targetPort: 8080,
        now: 1000
      })
      const targetJob = newJob({
        contestId: targetContestId,
        purpose: "competition",
        id: BenchJobId.make("bj-cross-target"),
        teamId: targetTeam.id,
        targetIp: "10.100.222.5",
        targetPort: 8080,
        now: 2000
      })
      yield* jobs.insertIfAllowed(otherJob)
      yield* jobs.insertIfAllowed(targetJob)

      const picked = yield* jobs.dequeueNextQueued(
        { contestId: targetContestId, purpose: "competition" },
        5000
      )
      expect(Option.isSome(picked)).toBe(true)
      if (Option.isSome(picked)) {
        expect(picked.value.id).toBe(targetJob.id)
        expect(picked.value.contestId).toBe(targetContestId)
      }
    })
  )
})

// Task 3 Step 5: 初ログイン時の invite 消費は draft/preparing/running/
// finalizing の live contest 限定。finished/canceled の残骸は無視する。
// SQL JOIN + status フィルタが実際に効いているかを SQL レイヤで検証する。
layer("InviteRepo: listByGithubLoginForLiveContests", (it) => {
  it.effect("live contest のみ返し、finished / canceled は除外する", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const teams = yield* TeamRepo
      const invites = yield* InviteRepo

      const liveContestId = ContestId.make("00000000-0000-0000-0000-cccccccccdd1")
      const finishedContestId = ContestId.make("00000000-0000-0000-0000-cccccccccdd2")
      const canceledContestId = ContestId.make("00000000-0000-0000-0000-cccccccccdd3")
      // running / finished / canceled を並置。idx_contests_edition_live は
      // canceled を除いた edition 一意なので edition を全部変える。
      yield* contests.create(makeContest({ id: liveContestId, edition: 21, status: "running" }))
      yield* contests.create(
        makeContest({ id: finishedContestId, edition: 22, status: "finished", finishedAt: Option.some(1_000_000) })
      )
      yield* contests.create(
        makeContest({ id: canceledContestId, edition: 23, status: "canceled", canceledAt: Option.some(1_000_100) })
      )

      // 3 contest それぞれに 1 チームずつ + 同じ github_login への招待を発行。
      const liveTeam = makeTeam({
        id: TeamId.make("team-invite-live"),
        contestId: liveContestId,
        name: "LiveTeam",
        teamNumber: 231
      })
      const finishedTeam = makeTeam({
        id: TeamId.make("team-invite-fin"),
        contestId: finishedContestId,
        name: "FinishedTeam",
        teamNumber: 232
      })
      const canceledTeam = makeTeam({
        id: TeamId.make("team-invite-cxl"),
        contestId: canceledContestId,
        name: "CanceledTeam",
        teamNumber: 233
      })
      yield* teams.create(liveTeam)
      yield* teams.create(finishedTeam)
      yield* teams.create(canceledTeam)

      const githubLogin = "octocat-invitee"
      yield* invites.create(
        makeInvite({ contestId: liveContestId, teamId: liveTeam.id, githubLogin, email: "live@example.com", invitedAt: 100 })
      )
      yield* invites.create(
        makeInvite({
          contestId: finishedContestId,
          teamId: finishedTeam.id,
          githubLogin,
          email: "fin@example.com",
          invitedAt: 200
        })
      )
      yield* invites.create(
        makeInvite({
          contestId: canceledContestId,
          teamId: canceledTeam.id,
          githubLogin,
          email: "cxl@example.com",
          invitedAt: 300
        })
      )

      const live = yield* invites.listByGithubLoginForLiveContests(githubLogin)
      expect(live.length).toBe(1)
      expect(live[0]?.contestId).toBe(liveContestId)
      expect(live[0]?.teamId).toBe(liveTeam.id)

      // 別 github_login は 0 件で返る (パラメータバインドが効いていること)。
      const other = yield* invites.listByGithubLoginForLiveContests("other-user")
      expect(other).toStrictEqual([])
    })
  )
})

// Task 3 Step 1: 「異 contest の finished ジョブが scoreboard に混ざらない」。
// scoreboard SQL の contest_id フィルタが機能していることを SQL レイヤで
// 直接検証する(WHERE t.contest_id と各サブクエリの contest_id 条件が
// 揃っていることの回帰テスト)。
layer("BenchJobRepo: scoreboard は edition を混ぜない", (it) => {
  it.effect("別 contest の finished job は scoreboard(c1) に現れない", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo

      const contestAId = ContestId.make("00000000-0000-0000-0000-cccccccccef1")
      const contestBId = ContestId.make("00000000-0000-0000-0000-cccccccccef2")
      yield* contests.create(makeContest({ id: contestAId, edition: 41, status: "running" }))
      yield* contests.create(makeContest({ id: contestBId, edition: 42, status: "draft" }))

      const teamA = makeTeam({
        id: TeamId.make("team-sb-iso-a"),
        contestId: contestAId,
        name: "ScoreboardIsoA",
        teamNumber: 241
      })
      const teamB = makeTeam({
        id: TeamId.make("team-sb-iso-b"),
        contestId: contestBId,
        name: "ScoreboardIsoB",
        teamNumber: 242
      })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      // 各 contest に finished competition job を 1 つずつ (異なる score) 投入。
      const jobA = newJob({
        contestId: contestAId,
        purpose: "competition",
        id: BenchJobId.make("bj-sb-iso-a"),
        teamId: teamA.id,
        targetIp: "10.100.301.5",
        targetPort: 8080,
        now: 1000
      })
      const jobB = newJob({
        contestId: contestBId,
        purpose: "competition",
        id: BenchJobId.make("bj-sb-iso-b"),
        teamId: teamB.id,
        targetIp: "10.100.302.5",
        targetPort: 8080,
        now: 1000
      })
      yield* jobs.insertIfAllowed(jobA)
      yield* jobs.insertIfAllowed(jobB)
      // 各ジョブを running → finished へ (別 contest でも running は同時に
      // 1 本以下という制約があるので、 A を先に finish してから B を扱う)。
      yield* jobs.dequeueNextQueued({ contestId: contestAId, purpose: "competition" }, 2000)
      yield* jobs.finishIfRunning(jobA.id, { score: 100, passed: true }, 3000)
      yield* jobs.dequeueNextQueued({ contestId: contestBId, purpose: "competition" }, 4000)
      yield* jobs.finishIfRunning(jobB.id, { score: 900, passed: true }, 5000)

      const boardA = yield* jobs.scoreboard(contestAId)
      expect(boardA.length).toBe(1)
      expect(boardA[0]?.teamId).toBe(teamA.id)
      expect(boardA[0]?.bestScore).toBe(100)
      expect(boardA[0]?.latestScore).toBe(100)

      const boardB = yield* jobs.scoreboard(contestBId)
      expect(boardB.length).toBe(1)
      expect(boardB[0]?.teamId).toBe(teamB.id)
      expect(boardB[0]?.bestScore).toBe(900)
      expect(boardB[0]?.latestScore).toBe(900)
    })
  )
})

// Task 3 Step 1: 「同一 user が異 contest でそれぞれ別チームに所属できる」。
// TeamRepo.findByUserId(contestId, userId) が (contest_id, user_id) の
// scoped unique に沿って contest ごとに独立解決することを検証する。
layer("TeamRepo: findByUserId は contest ごとに独立して解決する", (it) => {
  it.effect("同一 user が別 contest の別チームに所属していても、findByUserId は各 contest の team を返す", () =>
    Effect.gen(function* () {
      const contests = yield* ContestRepo
      const teams = yield* TeamRepo
      const users = yield* UserRepo

      const contestAId = ContestId.make("00000000-0000-0000-0000-cccccccceee1")
      const contestBId = ContestId.make("00000000-0000-0000-0000-cccccccceee2")
      yield* contests.create(makeContest({ id: contestAId, edition: 51, status: "draft" }))
      yield* contests.create(makeContest({ id: contestBId, edition: 52, status: "draft" }))

      const teamA = makeTeam({
        id: TeamId.make("team-uiso-a"),
        contestId: contestAId,
        name: "UserIsoA",
        teamNumber: 251
      })
      const teamB = makeTeam({
        id: TeamId.make("team-uiso-b"),
        contestId: contestBId,
        name: "UserIsoB",
        teamNumber: 252
      })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      const user = yield* users.upsertByGithub({
        githubId: 9301,
        githubLogin: "user-iso",
        displayName: "User Iso",
        isAdmin: false
      })
      // 同一 user を A/B 双方の team に所属させる。scoped unique
      // (contest_id, user_id) により同一 contest 内では 1 team だが、
      // 別 contest 間では別 team に所属可能。
      const addedA = yield* teams.addMember(contestAId, teamA.id, user.id)
      const addedB = yield* teams.addMember(contestBId, teamB.id, user.id)
      expect(addedA).toBe(true)
      expect(addedB).toBe(true)

      const foundInA = yield* teams.findByUserId(contestAId, user.id)
      expect(Option.isSome(foundInA)).toBe(true)
      if (Option.isSome(foundInA)) {
        expect(foundInA.value.id).toBe(teamA.id)
        expect(foundInA.value.contestId).toBe(contestAId)
      }

      const foundInB = yield* teams.findByUserId(contestBId, user.id)
      expect(Option.isSome(foundInB)).toBe(true)
      if (Option.isSome(foundInB)) {
        expect(foundInB.value.id).toBe(teamB.id)
        expect(foundInB.value.contestId).toBe(contestBId)
      }
    })
  )
})
