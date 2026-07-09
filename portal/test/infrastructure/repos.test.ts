import { it } from "@effect/vitest"
import { Effect, Exit, Layer, Option } from "effect"
import { expect } from "vitest"
import { newJob } from "../../src/domain/benchJob.js"
import { Contest } from "../../src/domain/contest.js"
import { Instance } from "../../src/domain/instance.js"
import { Team } from "../../src/domain/team.js"
import { User } from "../../src/domain/user.js"
import { TeamJobAlreadyQueued } from "../../src/domain/errors.js"
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
// 良い。UserRepoLive は UuidGen に依存するため明示的に provide する
// (Layer.mergeAll は兄弟レイヤー同士の依存を自動解決しないため)。
const RepoLayer = Layer.mergeAll(
  ContestRepoLive,
  UserRepoLive,
  SessionRepoLive,
  TeamRepoLive,
  InstanceRepoLive,
  BenchJobRepoLive,
  UuidGenLive
).pipe(Layer.provide(UuidGenLive), Layer.provideMerge(MigratorTest), Layer.provideMerge(SqlTest))

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
        privateIp: "10.100.102.10",
        status: "active"
      })
      yield* instances.create(instance)

      const listed = yield* instances.listByTeam(team.id)
      expect(listed).toStrictEqual([instance])

      yield* instances.remove(instance.id)
      const afterRemove = yield* instances.listByTeam(team.id)
      expect(afterRemove).toStrictEqual([])
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
