import { Effect, Option } from "effect"
import type { ContestId } from "../../domain/ids.js"
import { ArtifactId } from "../../domain/ids.js"
import type { Artifact } from "../../domain/artifact.js"
import { Artifact as ArtifactDomain } from "../../domain/artifact.js"
import type { ArtifactWriteResult } from "../ports.js"
import {
  ArtifactRepo,
  BackupError,
  BackupPort,
  BenchJobRepo,
  RepoError,
  UuidGen
} from "../ports.js"

// Task 11 §Step 4/5: scoreboard の JSON/CSV を生成し、artifact 行を upsert する
// 純粋な application 層のヘルパ。実際の write は BackupPort に委譲(唯一の
// I/O 境界; snapshot / scoreboard で write ロジックを重複させない)。
//
// - JSON body: BenchJobRepo.scoreboard の結果を UTF-8 で書き出す。key 順は
//   teamId, teamName, bestScore, latestScore, latestAt(公開 API と同じ順)。
// - CSV body: header は "teamId,teamName,bestScore,latestScore,latestAt" の
//   固定順(spec: 「stable CSV column order」)。値は RFC4180 の quote 規則で
//   escape する(値に `"`, `,`, `\r`, `\n` を含むときのみ quote)。
// - JSON/CSV は competition の finished ジョブのみを対象にする
//   (BenchJobRepo.scoreboard がすでにその filter を持つ)。
//
// 呼び出し順 (finish/backup Operation の step):
//   1. scoreboard 集計 (BenchJobRepo.scoreboard)
//   2. body を生成 (buildScoreboardJson / buildScoreboardCsv)
//   3. BackupPort.writeArtifact({kind, bytes})
//   4. ArtifactRepo.upsert({..., offHostStatus: 'not_applicable'})

const CSV_HEADER = "teamId,teamName,bestScore,latestScore,latestAt"

const csvEscape = (value: string): string => {
  // RFC 4180: quote は " → "", 値全体を " で囲む。CR/LF, comma, quote の
  // いずれかを含む値だけ quote する(それ以外は素の文字列で通す)。
  if (value.includes('"') || value.includes(",") || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

const nullableIntToCsv = (v: number | null): string => (v === null ? "" : String(v))

// 公開 wire に合わせて生 storagePath は含めない。scoreboard の中身は
// BenchJobRepo.scoreboard が既に purpose='competition' filter 済み。
export interface ScoreboardRow {
  readonly teamId: string
  readonly teamName: string
  readonly bestScore: number | null
  readonly latestScore: number | null
  readonly latestAt: number | null
}

export const buildScoreboardJson = (rows: ReadonlyArray<ScoreboardRow>): Uint8Array => {
  // 公開 GET /api/contests/:id/scoreboard と同じ形にする(json.parse 後に
  // 直接 shared/schemas の ScoreboardEntry でデコードできる)。
  const payload = rows.map((r) => ({
    teamId: r.teamId,
    teamName: r.teamName,
    bestScore: r.bestScore,
    latestScore: r.latestScore,
    latestAt: r.latestAt
  }))
  return new TextEncoder().encode(JSON.stringify(payload))
}

export const buildScoreboardCsv = (rows: ReadonlyArray<ScoreboardRow>): Uint8Array => {
  // 1 行目は固定 header、以降は teams.team_number 順(scoreboard 呼び出し側の
  // ORDER BY 順)を保つ。改行は LF 単一(RFC 4180 は CRLF 推奨だが、GitHub /
  // 表計算 は両方読める。将来 CRLF に変える場合はここだけを変える)。
  const body = rows
    .map((r) =>
      [
        csvEscape(r.teamId),
        csvEscape(r.teamName),
        nullableIntToCsv(r.bestScore),
        nullableIntToCsv(r.latestScore),
        nullableIntToCsv(r.latestAt)
      ].join(",")
    )
    .join("\n")
  const text = body.length === 0 ? `${CSV_HEADER}\n` : `${CSV_HEADER}\n${body}\n`
  return new TextEncoder().encode(text)
}

// application 層の共通ヘルパ: 書き込み結果 (storagePath/sha256/sizeBytes) を
// Artifact 行として upsert し、upsert 後の DB 側の正の行を返す。
//
// review round 2 finding 1: upsert は ON CONFLICT (contest_id, kind) DO UPDATE
// で id 列を保持する(regenerate 時に id は変えない)ため、application 側で
// 新規採番した uuid をそのまま返すと DB と食い違い、caller が返り値の id で
// GET/DELETE すると 404 になる。upsert 後に findByKind で正の行を取り直して
// 返すことで、この phantom id を防ぐ。
const persistArtifact = (args: {
  readonly contestId: ContestId
  readonly kind: Artifact["kind"]
  readonly now: number
  readonly write: ArtifactWriteResult
  readonly offHostStatus: Artifact["offHostStatus"]
}): Effect.Effect<Artifact, RepoError, ArtifactRepo | UuidGen> =>
  Effect.gen(function* () {
    const repo = yield* ArtifactRepo
    const uuid = yield* UuidGen
    const candidateId = ArtifactId.make(yield* uuid.next)
    const candidate = new ArtifactDomain({
      id: candidateId,
      contestId: args.contestId,
      kind: args.kind,
      storagePath: args.write.storagePath,
      sha256: args.write.sha256,
      sizeBytes: args.write.sizeBytes,
      offHostStatus: args.offHostStatus,
      verifiedAt: Option.none(),
      createdAt: args.now
    })
    yield* repo.upsert(candidate)
    const refreshed = yield* repo.findByKind(args.contestId, args.kind)
    if (Option.isNone(refreshed)) {
      // upsert 直後に消えるのは想定外(delete API 未実装)。die で顕在化。
      return yield* Effect.dieMessage(
        `persistArtifact: (${args.contestId}, ${args.kind}) row disappeared after upsert`
      )
    }
    return refreshed.value
  })

export const persistScoreboardJson = (args: {
  readonly contestId: ContestId
  readonly edition: number
  readonly now: number
  readonly rows: ReadonlyArray<ScoreboardRow>
}): Effect.Effect<Artifact, RepoError | BackupError, ArtifactRepo | BackupPort | UuidGen> =>
  Effect.gen(function* () {
    const bytes = buildScoreboardJson(args.rows)
    const port = yield* BackupPort
    const write = yield* port.writeArtifact({
      contestId: args.contestId,
      edition: args.edition,
      now: args.now,
      kind: "scoreboard",
      bytes
    })
    return yield* persistArtifact({
      contestId: args.contestId,
      kind: "scoreboard",
      now: args.now,
      write,
      // JSON/CSV は off-host copy を要求しない(public artifact)。
      offHostStatus: "not_applicable"
    })
  })

export const persistScoreboardCsv = (args: {
  readonly contestId: ContestId
  readonly edition: number
  readonly now: number
  readonly rows: ReadonlyArray<ScoreboardRow>
}): Effect.Effect<Artifact, RepoError | BackupError, ArtifactRepo | BackupPort | UuidGen> =>
  Effect.gen(function* () {
    const bytes = buildScoreboardCsv(args.rows)
    const port = yield* BackupPort
    const write = yield* port.writeArtifact({
      contestId: args.contestId,
      edition: args.edition,
      now: args.now,
      kind: "scoreboard_csv",
      bytes
    })
    return yield* persistArtifact({
      contestId: args.contestId,
      kind: "scoreboard_csv",
      now: args.now,
      write,
      offHostStatus: "not_applicable"
    })
  })

export const persistDbSnapshot = (args: {
  readonly contestId: ContestId
  readonly edition: number
  readonly now: number
}): Effect.Effect<Artifact, RepoError | BackupError, ArtifactRepo | BackupPort | UuidGen> =>
  Effect.gen(function* () {
    const port = yield* BackupPort
    const write = yield* port.createSnapshot({
      contestId: args.contestId,
      edition: args.edition,
      now: args.now
    })
    return yield* persistArtifact({
      contestId: args.contestId,
      kind: "snapshot",
      now: args.now,
      write,
      // DB snapshot は off-host copy を要求する(spec: browser download の flag は
      // 使わない、admin が手動で off-host に写した SHA-256 を verify で入力)。
      offHostStatus: "pending"
    })
  })

// scoreboard 集計→JSON body 生成は archive-only Operation でも finish Operation
// でも共通なので、BenchJobRepo からの読み取りをここに閉じ込める。
export const readScoreboardRows = (
  contestId: ContestId
): Effect.Effect<ReadonlyArray<ScoreboardRow>, RepoError, BenchJobRepo> =>
  Effect.gen(function* () {
    const jobs = yield* BenchJobRepo
    const rows = yield* jobs.scoreboard(contestId)
    return rows.map(
      (r): ScoreboardRow => ({
        teamId: r.teamId as unknown as string,
        teamName: r.teamName,
        bestScore: r.bestScore,
        latestScore: r.latestScore,
        latestAt: r.latestAt
      })
    )
  })
