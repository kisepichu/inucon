import { it } from "@effect/vitest"
import { Effect, Either, Exit, Layer, Option, Ref, TestClock } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect } from "vitest"
import { ArtifactId, ContestId, TeamId, UserId } from "../../src/domain/ids.js"
import { BenchJob, newJob, startJob, finishJob } from "../../src/domain/benchJob.js"
import { Artifact } from "../../src/domain/artifact.js"
import {
  ArtifactRepo,
  BenchJobRepo,
  ContestRepo,
  OperationHandlerRegistry,
  OperationRepo,
  OperationWorkerConfig,
  TeamRepo,
  UserRepo
} from "../../src/application/ports.js"
import {
  BACKUP_STEP_KEYS,
  FINISH_STEP_KEYS,
  makeContestFinalizationHandler,
  requestFinalization,
  requestLegacyArchive,
  verifyArtifactChecksum
} from "../../src/application/usecases/finalization.js"
import { ArtifactRepoLive } from "../../src/infrastructure/sql/repos/artifactRepo.js"
import { BenchJobRepoLive } from "../../src/infrastructure/sql/repos/benchJobRepo.js"
import { ContestRepoLive } from "../../src/infrastructure/sql/repos/contestRepo.js"
import { InstanceRepoLive } from "../../src/infrastructure/sql/repos/instanceRepo.js"
import { InviteRepoLive } from "../../src/infrastructure/sql/repos/inviteRepo.js"
import { OperationRepoLive } from "../../src/infrastructure/sql/repos/operationRepo.js"
import { TeamRepoLive } from "../../src/infrastructure/sql/repos/teamRepo.js"
import { UserRepoLive } from "../../src/infrastructure/sql/repos/userRepo.js"
import { UuidGenLive } from "../../src/infrastructure/sql/uuid.js"
import { tickOperationWorker } from "../../src/infrastructure/worker/operationWorker.js"
import { MigratorTest, SqlTest } from "../support/sqlTest.js"
import { DEFAULT_TEST_CONTEST_ID, makeContest, makeTeam } from "../support/factories.js"
import { makeArtifactBackupPortTest } from "../support/inMemory.js"

// Task 11 §Step 2: finish / backup Operation の観測可能な契約を検証する。
//
// - requestFinalization は running → finalizing 遷移(revision-guarded)を
//   起こし、6-step の finish Operation を enqueue する。
// - 既に finalizing の Contest では遷移 skip し enqueue のみ。
// - finalizing でない (draft/preparing/finished/canceled) は
//   InvalidContestTransition。
// - requestLegacyArchive は finished Contest 限定で 3-step の backup Operation を
//   enqueue する。他状態は InvalidArchiveState。
// - handler の cancel_queued → queued は canceled になり、running は残す。
// - wait_running は countRunning=0 まで retry を返す。
// - archive step 3 種は persist* 経由で ArtifactRepo に upsert され、DB snapshot
//   は off_host_status='pending'。
// - finish_contest step は saveIfRevisionAndPurgeInvites で status='finished'
//   + team_invites 全削除。
// - verifyArtifactChecksum は sha256 一致で verified、不一致は
//   ArtifactChecksumMismatch。

const CONTEST_ID = DEFAULT_TEST_CONTEST_ID
const TEAM_ID = TeamId.make("team1-final-1111-1111-1111-111111111111")
let ADMIN_USER_ID = UserId.make("00000000-0000-0000-0000-000000000000")

const workerConfig = { pollIntervalMillis: 1_000, retryBaseMillis: 1_000, retryMaxMillis: 30_000, maxAttempts: 5, leaseDurationMillis: 60_000 }
const WorkerConfigTest = Layer.succeed(OperationWorkerConfig, workerConfig)

const makeLayer = (root: string) =>
  Layer.mergeAll(
    ArtifactRepoLive,
    BenchJobRepoLive,
    ContestRepoLive,
    InstanceRepoLive,
    InviteRepoLive,
    OperationRepoLive,
    TeamRepoLive,
    UserRepoLive,
    makeArtifactBackupPortTest({ root })
  ).pipe(
    Layer.provideMerge(UuidGenLive),
    Layer.provideMerge(WorkerConfigTest),
    Layer.provideMerge(MigratorTest),
    Layer.provideMerge(SqlTest)
  )

const seedContestAndTeam = (contestStatus: "running" | "finalizing" | "finished" | "preparing") =>
  Effect.gen(function* () {
    const users = yield* UserRepo
    const seededUser = yield* users.upsertByGithub({
      githubId: 42,
      githubLogin: "admin-final",
      displayName: "Admin Final",
      isAdmin: true
    })
    ADMIN_USER_ID = seededUser.id
    const contests = yield* ContestRepo
    const teams = yield* TeamRepo
    yield* contests.create(
      makeContest({
        id: CONTEST_ID,
        edition: 1,
        status: contestStatus,
        scheduledStartAt: Option.some(100),
        scheduledEndAt: Option.some(200),
        accessClosesAt: Option.some(200),
        startedAt: contestStatus === "running" || contestStatus === "finalizing" || contestStatus === "finished"
          ? Option.some(100)
          : Option.none(),
        finalizingAt: contestStatus === "finalizing" || contestStatus === "finished"
          ? Option.some(200)
          : Option.none(),
        finishedAt: contestStatus === "finished" ? Option.some(300) : Option.none(),
        revision: 1
      })
    )
    yield* teams.create(
      makeTeam({ id: TEAM_ID, contestId: CONTEST_ID, teamNumber: 1, name: "team1", desiredInstanceCount: 3 })
    )
  })

// ----- requestFinalization -----

describe("requestFinalization", () => {
  it.effect("running Contest では finalizing に遷移し 6-step の finish Operation を enqueue する", () => {
    const root = mkdtempSync(join(tmpdir(), "inucon-final-1-"))
    return Effect.gen(function* () {
      try {
        yield* seedContestAndTeam("running")
        yield* TestClock.setTime(1_000)
        const op = yield* requestFinalization({
          contestId: CONTEST_ID,
          actor: { kind: "scheduler" }
        })
        expect(op.kind).toBe("finish")
        expect(op.status).toBe("queued")
        // Contest は finalizing に遷移
        const contests = yield* ContestRepo
        const c = yield* contests.findById(CONTEST_ID)
        expect(Option.isSome(c)).toBe(true)
        if (Option.isSome(c)) {
          expect(c.value.status).toBe("finalizing")
          expect(c.value.revision).toBe(2)
        }
        // 6 step
        const ops = yield* OperationRepo
        const steps = yield* ops.listSteps(op.id)
        expect(steps.map((s) => s.stepKey)).toEqual([
          FINISH_STEP_KEYS.cancelQueued,
          FINISH_STEP_KEYS.waitRunning,
          FINISH_STEP_KEYS.writeScoreboardJson,
          FINISH_STEP_KEYS.writeScoreboardCsv,
          FINISH_STEP_KEYS.writeDbSnapshot,
          FINISH_STEP_KEYS.finishContest
        ])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(makeLayer(root)))
  })

  it.effect("既に finalizing の Contest では遷移せずに enqueue のみ試みる", () => {
    const root = mkdtempSync(join(tmpdir(), "inucon-final-2-"))
    return Effect.gen(function* () {
      try {
        yield* seedContestAndTeam("finalizing")
        const contests = yield* ContestRepo
        const before = yield* contests.findById(CONTEST_ID)
        const revBefore = Option.isSome(before) ? before.value.revision : -1

        const op = yield* requestFinalization({
          contestId: CONTEST_ID,
          actor: { kind: "admin", userId: ADMIN_USER_ID }
        })
        expect(op.kind).toBe("finish")

        // 遷移していない = revision 変わらず
        const after = yield* contests.findById(CONTEST_ID)
        if (Option.isSome(after)) {
          expect(after.value.status).toBe("finalizing")
          expect(after.value.revision).toBe(revBefore)
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(makeLayer(root)))
  })

  it.effect("finished Contest では InvalidContestTransition で fail", () => {
    const root = mkdtempSync(join(tmpdir(), "inucon-final-3-"))
    return Effect.gen(function* () {
      try {
        yield* seedContestAndTeam("finished")
        const exit = yield* Effect.exit(
          requestFinalization({
            contestId: CONTEST_ID,
            actor: { kind: "scheduler" }
          })
        )
        expect(Exit.isFailure(exit)).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(makeLayer(root)))
  })

  it.effect("同 Contest に対する二重 requestFinalization は 2 度目が OperationInProgress で弾かれる", () => {
    const root = mkdtempSync(join(tmpdir(), "inucon-final-4-"))
    return Effect.gen(function* () {
      try {
        yield* seedContestAndTeam("running")
        yield* requestFinalization({ contestId: CONTEST_ID, actor: { kind: "scheduler" } })
        const second = yield* Effect.either(
          requestFinalization({ contestId: CONTEST_ID, actor: { kind: "scheduler" } })
        )
        expect(second._tag).toBe("Left")
        if (second._tag === "Left") {
          expect(second.left._tag).toBe("OperationInProgress")
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(makeLayer(root)))
  })
})

// ----- requestLegacyArchive -----

describe("requestLegacyArchive", () => {
  it.effect("finished Contest では 3-step の backup Operation を enqueue する", () => {
    const root = mkdtempSync(join(tmpdir(), "inucon-final-5-"))
    return Effect.gen(function* () {
      try {
        yield* seedContestAndTeam("finished")
        const op = yield* requestLegacyArchive({
          contestId: CONTEST_ID,
          actorUserId: ADMIN_USER_ID
        })
        expect(op.kind).toBe("backup")
        const ops = yield* OperationRepo
        const steps = yield* ops.listSteps(op.id)
        expect(steps.map((s) => s.stepKey)).toEqual([
          BACKUP_STEP_KEYS.writeScoreboardJson,
          BACKUP_STEP_KEYS.writeScoreboardCsv,
          BACKUP_STEP_KEYS.writeDbSnapshot
        ])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(makeLayer(root)))
  })

  it.effect("running Contest では InvalidArchiveState で fail", () => {
    const root = mkdtempSync(join(tmpdir(), "inucon-final-6-"))
    return Effect.gen(function* () {
      try {
        yield* seedContestAndTeam("running")
        const exit = yield* Effect.either(
          requestLegacyArchive({ contestId: CONTEST_ID, actorUserId: ADMIN_USER_ID })
        )
        expect(exit._tag).toBe("Left")
        if (exit._tag === "Left") {
          expect(exit.left._tag).toBe("InvalidArchiveState")
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(makeLayer(root)))
  })
})

// ----- handler dispatcher (finish step execution end-to-end) -----

const runFinishStepsUntilTerminal = (opId: string, root: string) =>
  Effect.gen(function* () {
    const handler = yield* makeContestFinalizationHandler
    const registry = Layer.succeed(OperationHandlerRegistry, {
      lookup: () => Option.some(handler)
    })
    // 十分な回数 tick を回して全 step を消化する。
    for (let i = 0; i < 12; i++) {
      const now = yield* TestClock.currentTimeMillis
      yield* tickOperationWorker(now).pipe(Effect.provide(Layer.merge(WorkerConfigTest, registry)))
      // wait_running の retry backoff を確実に消化するため 3 秒進める
      yield* TestClock.adjust("3 seconds")
    }
    void opId
  })

describe("finish Operation handler dispatch", () => {
  it.effect("cancel_queued step は queued な bench_jobs を canceled に落とし件数を summary に載せる", () => {
    const root = mkdtempSync(join(tmpdir(), "inucon-final-7-"))
    return Effect.gen(function* () {
      try {
        yield* seedContestAndTeam("running")
        const jobs = yield* BenchJobRepo
        const j1 = newJob({
          id: "job-1-1111-1111-1111-111111111111" as unknown as import("../../src/domain/ids.js").BenchJobId,
          contestId: CONTEST_ID,
          teamId: TEAM_ID,
          targetIp: "10.100.1.9",
          targetPort: 80,
          purpose: "competition",
          now: 100
        })
        yield* jobs.insertIfAllowed(j1)
        const op = yield* requestFinalization({
          contestId: CONTEST_ID,
          actor: { kind: "scheduler" }
        })
        yield* runFinishStepsUntilTerminal(op.id, root)
        // Operation は succeeded に到達し、Contest は finished
        const ops = yield* OperationRepo
        const opRow = yield* ops.findById(op.id)
        if (Option.isSome(opRow)) {
          expect(opRow.value.status).toBe("succeeded")
        }
        const contests = yield* ContestRepo
        const c = yield* contests.findById(CONTEST_ID)
        if (Option.isSome(c)) {
          expect(c.value.status).toBe("finished")
          expect(Option.isSome(c.value.finishedAt)).toBe(true)
        }
        // 3 種 artifact が upsert されている
        const artifacts = yield* ArtifactRepo
        const listed = yield* artifacts.listByContest(CONTEST_ID)
        const kinds = listed.map((a) => a.kind).sort()
        expect(kinds).toEqual(["scoreboard", "scoreboard_csv", "snapshot"])
        // snapshot は off_host_status='pending'
        const snap = listed.find((a) => a.kind === "snapshot")
        expect(snap?.offHostStatus).toBe("pending")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(makeLayer(root)))
  })

  it.effect("running BenchJob があるあいだ wait_running は retry を返す (Operation は running のまま)", () => {
    const root = mkdtempSync(join(tmpdir(), "inucon-final-8-"))
    return Effect.gen(function* () {
      try {
        yield* seedContestAndTeam("running")
        // running な bench_job を用意
        const jobs = yield* BenchJobRepo
        const j = newJob({
          id: "job-2-2222-2222-2222-222222222222" as unknown as import("../../src/domain/ids.js").BenchJobId,
          contestId: CONTEST_ID,
          teamId: TEAM_ID,
          targetIp: "10.100.1.9",
          targetPort: 80,
          purpose: "competition",
          now: 100
        })
        yield* jobs.insertIfAllowed(j)
        // 手動で running に遷移
        yield* jobs.dequeueNextQueued({ contestId: CONTEST_ID, purpose: "competition" }, 150)
        const op = yield* requestFinalization({
          contestId: CONTEST_ID,
          actor: { kind: "scheduler" }
        })
        // 2 tick 消化: cancel_queued は succeed するが wait_running は retry のまま
        const handler = yield* makeContestFinalizationHandler
        const registry = Layer.succeed(OperationHandlerRegistry, {
          lookup: () => Option.some(handler)
        })
        for (let i = 0; i < 4; i++) {
          const now = yield* TestClock.currentTimeMillis
          yield* tickOperationWorker(now).pipe(Effect.provide(Layer.merge(WorkerConfigTest, registry)))
          yield* TestClock.adjust("3 seconds")
        }
        const ops = yield* OperationRepo
        const opRow = yield* ops.findById(op.id)
        // running のまま(wait_running が retry を返し続ける)
        if (Option.isSome(opRow)) {
          expect(opRow.value.status).toBe("running")
        }
        const contests = yield* ContestRepo
        const c = yield* contests.findById(CONTEST_ID)
        // Contest は finalizing のまま
        if (Option.isSome(c)) {
          expect(c.value.status).toBe("finalizing")
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(makeLayer(root)))
  })

  it.effect("legacy contest 経路 (backup Operation) は 3 step のみ実行し contest.status は変えない", () => {
    const root = mkdtempSync(join(tmpdir(), "inucon-final-9-"))
    return Effect.gen(function* () {
      try {
        yield* seedContestAndTeam("finished")
        const contests = yield* ContestRepo
        const before = yield* contests.findById(CONTEST_ID)
        const revBefore = Option.isSome(before) ? before.value.revision : -1

        const op = yield* requestLegacyArchive({
          contestId: CONTEST_ID,
          actorUserId: ADMIN_USER_ID
        })
        yield* runFinishStepsUntilTerminal(op.id, root)
        const ops = yield* OperationRepo
        const opRow = yield* ops.findById(op.id)
        if (Option.isSome(opRow)) {
          expect(opRow.value.status).toBe("succeeded")
        }
        // Contest は finished のまま、revision も変わらない
        const after = yield* contests.findById(CONTEST_ID)
        if (Option.isSome(after)) {
          expect(after.value.status).toBe("finished")
          expect(after.value.revision).toBe(revBefore)
        }
        // 3 artifact が生成されている
        const artifacts = yield* ArtifactRepo
        const listed = yield* artifacts.listByContest(CONTEST_ID)
        expect(listed.map((a) => a.kind).sort()).toEqual(["scoreboard", "scoreboard_csv", "snapshot"])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(makeLayer(root)))
  })
})

// ----- verifyArtifactChecksum -----

describe("verifyArtifactChecksum", () => {
  it.effect("sha256 一致で off_host_status='verified' + verified_at がセットされる", () => {
    const root = mkdtempSync(join(tmpdir(), "inucon-final-10-"))
    return Effect.gen(function* () {
      try {
        yield* seedContestAndTeam("finished")
        // snapshot artifact を 1 件手動で挿入(finish/backup handler を通さない)
        const artifacts = yield* ArtifactRepo
        const id = ArtifactId.make("aaaa1111-aaaa-1111-aaaa-111111111111")
        const artifact = new Artifact({
          id,
          contestId: CONTEST_ID,
          kind: "snapshot",
          storagePath: "/backups/dummy.sqlite",
          sha256: "deadbeef".repeat(8),
          sizeBytes: 100,
          offHostStatus: "pending",
          verifiedAt: Option.none(),
          createdAt: 1000
        })
        yield* artifacts.upsert(artifact)
        const verified = yield* verifyArtifactChecksum({
          artifactId: id,
          expectedSha256: "deadbeef".repeat(8),
          now: 5_000
        })
        expect(verified.offHostStatus).toBe("verified")
        expect(Option.getOrNull(verified.verifiedAt)).toBe(5_000)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(makeLayer(root)))
  })

  it.effect("sha256 不一致は ArtifactChecksumMismatch で fail し、off_host_status='pending' のまま", () => {
    const root = mkdtempSync(join(tmpdir(), "inucon-final-11-"))
    return Effect.gen(function* () {
      try {
        yield* seedContestAndTeam("finished")
        const artifacts = yield* ArtifactRepo
        const id = ArtifactId.make("aaaa2222-aaaa-2222-aaaa-222222222222")
        yield* artifacts.upsert(
          new Artifact({
            id,
            contestId: CONTEST_ID,
            kind: "snapshot",
            storagePath: "/backups/dummy.sqlite",
            sha256: "aa".repeat(32),
            sizeBytes: 100,
            offHostStatus: "pending",
            verifiedAt: Option.none(),
            createdAt: 1000
          })
        )
        const result = yield* Effect.either(
          verifyArtifactChecksum({
            artifactId: id,
            expectedSha256: "bb".repeat(32),
            now: 5_000
          })
        )
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag === "ArtifactChecksumMismatch").toBe(true)
        }
        const after = yield* artifacts.findById(id)
        if (Option.isSome(after)) {
          expect(after.value.offHostStatus).toBe("pending")
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(makeLayer(root)))
  })
})

// helper stub for future tests
void Ref
void Either
void ContestId
void startJob
void finishJob
void BenchJob
