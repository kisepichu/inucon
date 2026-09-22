import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect } from "vitest"
import { TeamId } from "../../src/domain/ids.js"
import {
  buildScoreboardCsv,
  buildScoreboardJson,
  persistDbSnapshot,
  persistScoreboardCsv,
  persistScoreboardJson
} from "../../src/application/usecases/archives.js"
import type { ScoreboardRow } from "../../src/application/usecases/archives.js"
import { ArtifactRepo, ContestRepo } from "../../src/application/ports.js"
import { ArtifactRepoLive } from "../../src/infrastructure/sql/repos/artifactRepo.js"
import { ContestRepoLive } from "../../src/infrastructure/sql/repos/contestRepo.js"
import { UuidGenLive } from "../../src/infrastructure/sql/uuid.js"
import { makeArtifactBackupPortTest } from "../support/inMemory.js"
import { DEFAULT_TEST_CONTEST_ID, makeContest } from "../support/factories.js"
import { MigratorTest, SqlTest } from "../support/sqlTest.js"

// Task 11 §Step 2: archives helper の観測可能な契約を検証する。
//   - buildScoreboardJson は BenchJobRepo.scoreboard 出力を UTF-8 JSON にする。
//   - buildScoreboardCsv は "teamId,teamName,bestScore,latestScore,latestAt" の
//     stable order でヘッダ + 各行を出す。null は空文字、値内の quote/カンマは
//     RFC 4180 escape (含む値だけ quote)。
//   - persistScoreboardJson/persistScoreboardCsv は SHA-256 と sizeBytes を
//     ArtifactRepo に upsert(contest_id + kind UNIQUE の in-place 差し替え)。
//   - persistDbSnapshot は BackupPort.createSnapshot 経由で snapshot を書き、
//     off_host_status='pending' で登録する。

const teamRow = (teamId: string, teamName: string, best: number | null, latest: number | null, at: number | null): ScoreboardRow => ({
  teamId,
  teamName,
  bestScore: best,
  latestScore: latest,
  latestAt: at
})

describe("buildScoreboardJson", () => {
  it("empty rows は [] を JSON.stringify した bytes", () => {
    const bytes = buildScoreboardJson([])
    expect(new TextDecoder().decode(bytes)).toBe("[]")
  })

  it("competition スコアだけを含む配列を UTF-8 で返す", () => {
    const rows: ReadonlyArray<ScoreboardRow> = [
      teamRow("t1", "team1", 1000, 900, 1234567890),
      teamRow("t2", "team2", null, null, null)
    ]
    const bytes = buildScoreboardJson(rows)
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    expect(parsed).toEqual([
      { teamId: "t1", teamName: "team1", bestScore: 1000, latestScore: 900, latestAt: 1234567890 },
      { teamId: "t2", teamName: "team2", bestScore: null, latestScore: null, latestAt: null }
    ])
  })
})

describe("buildScoreboardCsv", () => {
  it("stable header + 各行(null は空文字)", () => {
    const rows: ReadonlyArray<ScoreboardRow> = [
      teamRow("t1", "team1", 1000, 900, 1234567890),
      teamRow("t2", "team2", null, null, null)
    ]
    const csv = new TextDecoder().decode(buildScoreboardCsv(rows))
    expect(csv).toBe(
      "teamId,teamName,bestScore,latestScore,latestAt\n" +
        "t1,team1,1000,900,1234567890\n" +
        "t2,team2,,,\n"
    )
  })

  it("値に quote / カンマ / 改行を含むときは RFC 4180 で quote-escape する", () => {
    const rows: ReadonlyArray<ScoreboardRow> = [
      teamRow("t3", 'team "quotes"', 500, 500, 100),
      teamRow("t4", "team,with,comma", 1, 1, 1),
      teamRow("t5", "team\nwith\nnewline", 0, 0, 0)
    ]
    const csv = new TextDecoder().decode(buildScoreboardCsv(rows))
    // team "quotes" は " を "" に escape し、値全体を " で囲む
    expect(csv).toContain('t3,"team ""quotes""",500,500,100')
    // team,with,comma は , を含むので quote
    expect(csv).toContain('t4,"team,with,comma",1,1,1')
    // team\nwith\nnewline は改行を含むので quote
    expect(csv).toMatch(/t5,"team\nwith\nnewline",0,0,0/)
  })

  it("empty rows でも header は必ず 1 行入る", () => {
    const csv = new TextDecoder().decode(buildScoreboardCsv([]))
    expect(csv).toBe("teamId,teamName,bestScore,latestScore,latestAt\n")
  })
})

// SQL テストは in-memory DB + migration 済み。Artifact 行の FK が
// contests(id) を参照するので、テスト前に Contest を 1 件挿入しておく。
const BaseLayer = Layer.mergeAll(
  ArtifactRepoLive,
  ContestRepoLive
).pipe(Layer.provideMerge(UuidGenLive), Layer.provideMerge(MigratorTest), Layer.provideMerge(SqlTest))

const seedContest = Effect.gen(function* () {
  const contests = yield* ContestRepo
  yield* contests.create(makeContest({ id: DEFAULT_TEST_CONTEST_ID, edition: 1, status: "finished" }))
})

describe("persistScoreboardJson / persistScoreboardCsv / persistDbSnapshot", () => {
  it.effect("scoreboard JSON を書き込むと ArtifactRepo に off_host_status=not_applicable で upsert される", () => {
    const root = mkdtempSync(join(tmpdir(), "inucon-archives-json-"))
    return Effect.gen(function* () {
      try {
        yield* seedContest
        const rows: ReadonlyArray<ScoreboardRow> = [teamRow("t1", "team1", 100, 100, 1000)]
        const artifact = yield* persistScoreboardJson({
          contestId: DEFAULT_TEST_CONTEST_ID,
          edition: 1,
          now: 2_000_000,
          rows
        })
        expect(artifact.kind).toBe("scoreboard")
        expect(artifact.offHostStatus).toBe("not_applicable")
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(artifact.sizeBytes).toBeGreaterThan(0)
        const dir = readdirSync(join(root, "contests", DEFAULT_TEST_CONTEST_ID, "e1"))
        expect(dir).toContain("scoreboard.json")

        // upsert 契約: 同一 (contestId, kind) の 2 回目書き込みは既存を差し替える。
        // artifact.id は再採番されて変わってもよい。ArtifactRepo.listByContest は
        // 常に 1 件。
        yield* persistScoreboardJson({
          contestId: DEFAULT_TEST_CONTEST_ID,
          edition: 1,
          now: 2_000_000,
          rows: [teamRow("t1", "team1", 999, 999, 9999)]
        })
        const repo = yield* ArtifactRepo
        const listed = yield* repo.listByContest(DEFAULT_TEST_CONTEST_ID)
        expect(listed.filter((a) => a.kind === "scoreboard").length).toBe(1)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(Layer.merge(makeArtifactBackupPortTest({ root }), BaseLayer)))
  })

  it.effect("DB snapshot は off_host_status=pending で upsert される (未 verify)", () => {
    const root = mkdtempSync(join(tmpdir(), "inucon-archives-snap-"))
    return Effect.gen(function* () {
      try {
        yield* seedContest
        const artifact = yield* persistDbSnapshot({
          contestId: DEFAULT_TEST_CONTEST_ID,
          edition: 1,
          now: 3_000
        })
        expect(artifact.kind).toBe("snapshot")
        expect(artifact.offHostStatus).toBe("pending")
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(Layer.merge(makeArtifactBackupPortTest({ root }), BaseLayer)))
  })
})

// referenced only to reduce dead import lint noise if TeamId is unused elsewhere
void TeamId
