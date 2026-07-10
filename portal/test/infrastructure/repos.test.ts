import { it } from "@effect/vitest"
import { Effect, Exit, Layer, Option } from "effect"
import { expect } from "vitest"
import { newJob } from "../../src/domain/benchJob.js"
import { Contest } from "../../src/domain/contest.js"
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
import {
  BenchJobRepo,
  ContestRepo,
  InstanceRepo,
  SessionRepo,
  TeamRepo,
  UserRepo,
  UuidGen
} from "../../src/application/ports.js"
import { BenchJobRepoLive } from "../../src/infrastructure/sql/repos/benchJobRepo.js"
import { ContestRepoLive } from "../../src/infrastructure/sql/repos/contestRepo.js"
import { InstanceRepoLive } from "../../src/infrastructure/sql/repos/instanceRepo.js"
import { SessionRepoLive } from "../../src/infrastructure/sql/repos/sessionRepo.js"
import { TeamRepoLive } from "../../src/infrastructure/sql/repos/teamRepo.js"
import { UserRepoLive } from "../../src/infrastructure/sql/repos/userRepo.js"
import { UuidGenLive } from "../../src/infrastructure/sql/uuid.js"
import { MigratorTest, SqlTest } from "../support/sqlTest.js"

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
  BenchJobRepoLive
).pipe(Layer.provideMerge(UuidGenLive), Layer.provideMerge(MigratorTest), Layer.provideMerge(SqlTest))

const layer = it.layer(RepoLayer)

layer("ContestRepo", (it) => {
  it.effect("getCurrent: 未 save なら None、save 後は取得できる", () =>
    Effect.gen(function* () {
      const repo = yield* ContestRepo
      const before = yield* repo.getCurrent
      expect(before).toStrictEqual(Option.none())

      const contest = new Contest({
        id: ContestId.make("contest-1"),
        name: "INUCON",
        problemKey: "problem-1",
        status: "preparing"
      })
      yield* repo.save(contest)
      const after = yield* repo.getCurrent
      expect(after).toStrictEqual(Option.some(contest))
    })
  )

  it.effect("save は既存の現在コンテストを置き換える", () =>
    Effect.gen(function* () {
      const repo = yield* ContestRepo
      const first = new Contest({
        id: ContestId.make("contest-a"),
        name: "A",
        problemKey: "p1",
        status: "preparing"
      })
      const second = new Contest({
        id: ContestId.make("contest-b"),
        name: "B",
        problemKey: "p2",
        status: "running"
      })
      yield* repo.save(first)
      yield* repo.save(second)
      const current = yield* repo.getCurrent
      expect(current).toStrictEqual(Option.some(second))
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
      const teams = yield* TeamRepo
      const users = yield* UserRepo

      const team = new Team({ id: TeamId.make("team-repo-1"), name: "Team Repo 1", teamNumber: 101 })
      yield* teams.create(team)

      const all = yield* teams.list
      expect(all.some((t) => t.id === team.id)).toBe(true)

      const found = yield* teams.findById(team.id)
      expect(found).toStrictEqual(Option.some(team))

      const user = yield* users.upsertByGithub({
        githubId: 3001,
        githubLogin: "teamuser",
        displayName: "Team User",
        isAdmin: false
      })
      yield* teams.setMembers(team.id, [user.id])

      const byUser = yield* teams.findByUserId(user.id)
      expect(byUser).toStrictEqual(Option.some(team))

      const members = yield* teams.listMembers(team.id)
      expect(members).toStrictEqual([user])
    })
  )
})

layer("TeamRepo: setMembers 複数行 INSERT", (it) => {
  it.effect("2人を一度に set すると listMembers が2人返す", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const users = yield* UserRepo
      const team = new Team({ id: TeamId.make("team-members-multi"), name: "Members Multi", teamNumber: 211 })
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

      yield* teams.setMembers(team.id, [user1.id, user2.id])

      const members = yield* teams.listMembers(team.id)
      expect(
        members.map((m) => m.id).slice().sort()
      ).toStrictEqual([user1.id, user2.id].slice().sort())
    })
  )
})

layer("InstanceRepo", (it) => {
  it.effect("create/listByTeam/remove", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo

      const team = new Team({ id: TeamId.make("team-repo-instances"), name: "Instances Team", teamNumber: 102 })
      yield* teams.create(team)

      const instance = new Instance({
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

      const listed = yield* instances.listByTeam(team.id)
      expect(listed).toStrictEqual([instance])

      yield* instances.remove(instance.id)
      const afterRemove = yield* instances.listByTeam(team.id)
      expect(afterRemove).toStrictEqual([])
    })
  )
})

layer("InstanceRepo: create 重複拒否", (it) => {
  it.effect("同一 (team, index) の二重 create は DuplicateInstanceIndex", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = new Team({ id: TeamId.make("team-repo-instances-dup"), name: "Instances Dup", teamNumber: 103 })
      yield* teams.create(team)

      const first = new Instance({
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

      const second = new Instance({
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
      const listed = yield* instances.listByTeam(team.id)
      expect(listed).toStrictEqual([first])
    })
  )

  it.effect("deleted 行がある idx は再作成できる(部分ユニークインデックス)", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const instances = yield* InstanceRepo
      const team = new Team({ id: TeamId.make("team-repo-idx-reuse"), name: "Idx Reuse", teamNumber: 104 })
      yield* teams.create(team)

      // idx=1 を deleted 状態で登録(過去に使って撤収済みの想定)
      const old = new Instance({
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
      const fresh = new Instance({
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
})

// BenchJobRepo は「全体で running は同時に 1 本まで」というテーブル全体に
// わたる不変条件を持つため、シナリオ同士が同じ DB を共有すると前のテストが
// 残した queued/running 行が後続の dequeue 判定に混入してしまう。そのため
// 1 シナリオ = 1 個の layer(...) 呼び出し(= 独立した :memory: DB)に分ける。
layer("BenchJobRepo: insertIfAllowed 重複拒否", (it) => {
  it.effect("同チームに queued/running があれば TeamJobAlreadyQueued", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = new Team({ id: TeamId.make("team-bj-dup"), name: "BJ Dup", teamNumber: 111 })
      yield* teams.create(team)

      const job1 = newJob({
        id: BenchJobId.make("bj-dup-1"),
        teamId: team.id,
        targetIp: "10.100.111.5",
        targetPort: 8080,
        now: 1000
      })
      const inserted = yield* jobs.insertIfAllowed(job1)
      expect(inserted).toStrictEqual(job1)

      const job2 = newJob({
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

layer("BenchJobRepo: appendLog", (it) => {
  it.effect("追記になる", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = new Team({ id: TeamId.make("team-bj-log"), name: "BJ Log", teamNumber: 112 })
      yield* teams.create(team)

      const job = newJob({
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
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const teamA = new Team({ id: TeamId.make("team-bj-fifo-a"), name: "FIFO A", teamNumber: 121 })
      const teamB = new Team({ id: TeamId.make("team-bj-fifo-b"), name: "FIFO B", teamNumber: 122 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      const jobA = newJob({
        id: BenchJobId.make("bj-fifo-a"),
        teamId: teamA.id,
        targetIp: "10.100.121.5",
        targetPort: 8080,
        now: 1000
      })
      const jobB = newJob({
        id: BenchJobId.make("bj-fifo-b"),
        teamId: teamB.id,
        targetIp: "10.100.122.5",
        targetPort: 8080,
        now: 2000
      })
      yield* jobs.insertIfAllowed(jobA)
      yield* jobs.insertIfAllowed(jobB)

      const first = yield* jobs.dequeueNextQueued(5000)
      expect(Option.isSome(first)).toBe(true)
      if (Option.isSome(first)) {
        expect(first.value.id).toBe(jobA.id)
        expect(first.value.status).toBe("running")
      }

      // まだ running が存在するので次の dequeue は None
      const second = yield* jobs.dequeueNextQueued(6000)
      expect(second).toStrictEqual(Option.none())
    })
  )
})

layer("BenchJobRepo: 状態遷移", (it) => {
  it.effect("recordProgressIfRunning/finishIfRunning/cancelIfQueued の正常系", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = new Team({ id: TeamId.make("team-bj-transitions"), name: "Transitions", teamNumber: 131 })
      yield* teams.create(team)

      const cancelTarget = newJob({
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
        id: BenchJobId.make("bj-run-1"),
        teamId: team.id,
        targetIp: "10.100.131.6",
        targetPort: 8080,
        now: 2000
      })
      yield* jobs.insertIfAllowed(runTarget)
      const running = yield* jobs.dequeueNextQueued(3000)
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
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = new Team({ id: TeamId.make("team-bj-sweep"), name: "Sweep", teamNumber: 141 })
      yield* teams.create(team)

      const job = newJob({
        id: BenchJobId.make("bj-sweep-1"),
        teamId: team.id,
        targetIp: "10.100.141.5",
        targetPort: 8080,
        now: 0
      })
      yield* jobs.insertIfAllowed(job)
      yield* jobs.dequeueNextQueued(0)

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
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const teamA = new Team({ id: TeamId.make("team-scoreboard-a"), name: "Scoreboard A", teamNumber: 151 })
      const teamB = new Team({ id: TeamId.make("team-scoreboard-b"), name: "Scoreboard B", teamNumber: 152 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      // teamA: finished(score=50, finishedAt=1000), finished(score=80, finishedAt=2000)
      //   → best=80, latest=80(finishedAt=2000 の行)
      const a1 = newJob({
        id: BenchJobId.make("bj-sb-a1"),
        teamId: teamA.id,
        targetIp: "10.100.151.1",
        targetPort: 8080,
        now: 100
      })
      yield* jobs.insertIfAllowed(a1)
      yield* jobs.dequeueNextQueued(100)
      yield* jobs.finishIfRunning(a1.id, { score: 50, passed: true }, 1000)

      const a2 = newJob({
        id: BenchJobId.make("bj-sb-a2"),
        teamId: teamA.id,
        targetIp: "10.100.151.2",
        targetPort: 8080,
        now: 1500
      })
      yield* jobs.insertIfAllowed(a2)
      yield* jobs.dequeueNextQueued(1500)
      yield* jobs.finishIfRunning(a2.id, { score: 80, passed: true }, 2000)

      // teamB: finished(score=99, finishedAt=500), canceled(集計対象外)
      const b1 = newJob({
        id: BenchJobId.make("bj-sb-b1"),
        teamId: teamB.id,
        targetIp: "10.100.152.1",
        targetPort: 8080,
        now: 50
      })
      yield* jobs.insertIfAllowed(b1)
      yield* jobs.dequeueNextQueued(50)
      yield* jobs.finishIfRunning(b1.id, { score: 99, passed: false }, 500)

      const b2 = newJob({
        id: BenchJobId.make("bj-sb-b2"),
        teamId: teamB.id,
        targetIp: "10.100.152.2",
        targetPort: 8080,
        now: 3000
      })
      yield* jobs.insertIfAllowed(b2)
      yield* jobs.cancelIfQueued(b2.id)

      const board = yield* jobs.scoreboard
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
      const teamC = new Team({ id: TeamId.make("team-scoreboard-c"), name: "Scoreboard C", teamNumber: 153 })
      yield* teams.create(teamC)
      const boardWithC = yield* jobs.scoreboard
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
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = new Team({ id: TeamId.make("team-sb-bl"), name: "SB Best/Latest", teamNumber: 161 })
      yield* teams.create(team)

      const job1 = newJob({
        id: BenchJobId.make("bj-sb-bl-1"),
        teamId: team.id,
        targetIp: "10.100.161.1",
        targetPort: 8080,
        now: 100
      })
      yield* jobs.insertIfAllowed(job1)
      yield* jobs.dequeueNextQueued(100)
      yield* jobs.finishIfRunning(job1.id, { score: 500, passed: true }, 1000)

      const job2 = newJob({
        id: BenchJobId.make("bj-sb-bl-2"),
        teamId: team.id,
        targetIp: "10.100.161.2",
        targetPort: 8080,
        now: 1500
      })
      yield* jobs.insertIfAllowed(job2)
      yield* jobs.dequeueNextQueued(1500)
      yield* jobs.finishIfRunning(job2.id, { score: 300, passed: true }, 2000)

      const board = yield* jobs.scoreboard
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
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = new Team({ id: TeamId.make("team-sb-tie"), name: "SB Tie", teamNumber: 191 })
      yield* teams.create(team)

      // "bj-sb-tie-2" > "bj-sb-tie-1" (文字列比較) なので id DESC では
      // job2 が先頭に来る。score をあえて best とは逆にして、latest が
      // score の大小ではなく id で決まっていることを検証する。
      const job1 = newJob({
        id: BenchJobId.make("bj-sb-tie-1"),
        teamId: team.id,
        targetIp: "10.100.191.1",
        targetPort: 8080,
        now: 100
      })
      yield* jobs.insertIfAllowed(job1)
      yield* jobs.dequeueNextQueued(100)
      yield* jobs.finishIfRunning(job1.id, { score: 90, passed: true }, 5000)

      const job2 = newJob({
        id: BenchJobId.make("bj-sb-tie-2"),
        teamId: team.id,
        targetIp: "10.100.191.2",
        targetPort: 8080,
        now: 1500
      })
      yield* jobs.insertIfAllowed(job2)
      yield* jobs.dequeueNextQueued(1500)
      yield* jobs.finishIfRunning(job2.id, { score: 10, passed: true }, 5000)

      const board = yield* jobs.scoreboard
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
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const teamA = new Team({ id: TeamId.make("team-list-a"), name: "List A", teamNumber: 181 })
      const teamB = new Team({ id: TeamId.make("team-list-b"), name: "List B", teamNumber: 182 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      // 同一チームは queued/running を同時に 1 本しか持てないため、都度
      // cancelIfQueued で退避させてから次を積む。
      const a1 = newJob({
        id: BenchJobId.make("bj-list-a1"),
        teamId: teamA.id,
        targetIp: "10.100.181.1",
        targetPort: 8080,
        now: 100
      })
      yield* jobs.insertIfAllowed(a1)
      yield* jobs.cancelIfQueued(a1.id)

      const a2 = newJob({
        id: BenchJobId.make("bj-list-a2"),
        teamId: teamA.id,
        targetIp: "10.100.181.2",
        targetPort: 8080,
        now: 200
      })
      yield* jobs.insertIfAllowed(a2)
      yield* jobs.cancelIfQueued(a2.id)

      const a3 = newJob({
        id: BenchJobId.make("bj-list-a3"),
        teamId: teamA.id,
        targetIp: "10.100.181.3",
        targetPort: 8080,
        now: 300
      })
      yield* jobs.insertIfAllowed(a3)
      yield* jobs.cancelIfQueued(a3.id)

      const b1 = newJob({
        id: BenchJobId.make("bj-list-b1"),
        teamId: teamB.id,
        targetIp: "10.100.182.1",
        targetPort: 8080,
        now: 250
      })
      yield* jobs.insertIfAllowed(b1)

      const listedA = yield* jobs.listByTeam(teamA.id, 2)
      expect(listedA.map((j) => j.id)).toStrictEqual([a3.id, a2.id])

      const listedB = yield* jobs.listByTeam(teamB.id, 10)
      expect(listedB.map((j) => j.id)).toStrictEqual([b1.id])
    })
  )
})

layer("BenchJobRepo: dequeueNextQueued の同一 enqueued_at タイブレーク", (it) => {
  it.effect("id 昇順の方が先に出る(挿入順ではない)", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const teamA = new Team({ id: TeamId.make("team-dq-tie-a"), name: "DQ Tie A", teamNumber: 201 })
      const teamB = new Team({ id: TeamId.make("team-dq-tie-b"), name: "DQ Tie B", teamNumber: 202 })
      yield* teams.create(teamA)
      yield* teams.create(teamB)

      // id の大きい方 (z) を先に挿入し、あとから id の小さい方 (a) を挿入する。
      // enqueued_at が同値のとき挿入順ではなく id 昇順で先頭が決まることを検証する。
      const jobZ = newJob({
        id: BenchJobId.make("bj-dq-tie-z"),
        teamId: teamA.id,
        targetIp: "10.100.201.1",
        targetPort: 8080,
        now: 1000
      })
      yield* jobs.insertIfAllowed(jobZ)
      const jobA = newJob({
        id: BenchJobId.make("bj-dq-tie-a"),
        teamId: teamB.id,
        targetIp: "10.100.202.1",
        targetPort: 8080,
        now: 1000
      })
      yield* jobs.insertIfAllowed(jobA)

      const dequeued = yield* jobs.dequeueNextQueued(2000)
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
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = new Team({
        id: TeamId.make("team-err-finish-queued"),
        name: "Err Finish Queued",
        teamNumber: 171
      })
      yield* teams.create(team)

      const job = newJob({
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
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = new Team({
        id: TeamId.make("team-err-progress-queued"),
        name: "Err Progress Queued",
        teamNumber: 172
      })
      yield* teams.create(team)

      const job = newJob({
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
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = new Team({
        id: TeamId.make("team-err-cancel-running"),
        name: "Err Cancel Running",
        teamNumber: 173
      })
      yield* teams.create(team)

      const job = newJob({
        id: BenchJobId.make("bj-err-cancel-running"),
        teamId: team.id,
        targetIp: "10.100.173.5",
        targetPort: 8080,
        now: 1000
      })
      yield* jobs.insertIfAllowed(job)
      yield* jobs.dequeueNextQueued(2000)

      const err = yield* Effect.flip(jobs.cancelIfQueued(job.id))
      expect(err).toStrictEqual(new CannotCancelRunning({ jobId: job.id }))
    })
  )
})

layer("BenchJobRepo: cancelIfQueued は finished ジョブに失敗する", (it) => {
  it.effect("InvalidJobTransition(from: finished, action: cancel)", () =>
    Effect.gen(function* () {
      const teams = yield* TeamRepo
      const jobs = yield* BenchJobRepo
      const team = new Team({
        id: TeamId.make("team-err-cancel-finished"),
        name: "Err Cancel Finished",
        teamNumber: 174
      })
      yield* teams.create(team)

      const job = newJob({
        id: BenchJobId.make("bj-err-cancel-finished"),
        teamId: team.id,
        targetIp: "10.100.174.5",
        targetPort: 8080,
        now: 1000
      })
      yield* jobs.insertIfAllowed(job)
      yield* jobs.dequeueNextQueued(2000)
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
