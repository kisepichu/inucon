import { HttpApiBuilder, HttpServerResponse } from "@effect/platform"
import { Clock, Effect, Option } from "effect"
import {
  api,
  ArtifactChecksumMismatch,
  ContestRevisionConflict,
  CurrentUser,
  InvalidArchiveState,
  InvalidContestTransition,
  NotFound,
  OperationalContestConflict
} from "shared"
import { ArtifactRepo, BackupPort, ContestRepo } from "../../../application/ports.js"
import type { Artifact } from "../../../domain/artifact.js"
import {
  requestFinalization,
  requestLegacyArchive,
  verifyArtifactChecksum
} from "../../../application/usecases/finalization.js"

// Artifact の wire 射影。生 storagePath を落とすのがこの境界の契約なので、
// 3 つの応答経路 (公開 list / admin list / verify) で lockstep に保つ。
const toWireArtifact = (a: Artifact) => ({
  id: a.id,
  contestId: a.contestId,
  kind: a.kind,
  sha256: a.sha256,
  sizeBytes: a.sizeBytes,
  offHostStatus: a.offHostStatus,
  verifiedAt: Option.getOrNull(a.verifiedAt),
  createdAt: a.createdAt
})

// Task 11: artifact group の handler。
// - listContestArtifacts: 公開経路。scoreboard/scoreboard_csv のみを返す
//   (snapshot は admin だけが取得できる情報)。
// - listAdminContestArtifacts: AdminOnly。snapshot を含む全 kind を返す。
//   canceled Contest でも 404 にしない (contestAdmin.ts の getAdminContest /
//   listAdminContests({includeCanceled}) と同じく、admin には canceled を
//   隠さない前例に合わせる。canceled でも DB snapshot の off-host 検証は
//   必要になる)。公開 list と違い存在しない contestId のみ 404。
// - downloadArtifact: 公開経路。scoreboard/CSV のみを 200 で返す。snapshot は
//   URL 存在自体を隠すため 404。
// - downloadAdminArtifact: AdminOnly。任意 kind を返す。DB snapshot は
//   Cache-Control: no-store。
// - verifyArtifactChecksum: AdminOnly。offHostStatus='verified' に上げる。
// - requestContestFinalize: AdminOnly。手動 immediate finish。scheduler と
//   同じ Operation 経路。
// - requestContestArchive: AdminOnly。legacy contest の archive-only 再生成。
export const ArtifactsLive = HttpApiBuilder.group(api, "artifacts", (handlers) =>
  handlers
    .handle("listContestArtifacts", ({ path }) =>
      Effect.gen(function* () {
        const contests = yield* ContestRepo
        const contest = yield* contests.findById(path.contestId)
        if (Option.isNone(contest) || contest.value.status === "canceled") {
          return yield* Effect.fail(new NotFound())
        }
        const repo = yield* ArtifactRepo
        const all = yield* repo.listByContest(path.contestId)
        return all.filter((a) => a.kind !== "snapshot").map(toWireArtifact)
      }).pipe(Effect.orDie)
    )
    .handle("listAdminContestArtifacts", ({ path }) =>
      Effect.gen(function* () {
        const contests = yield* ContestRepo
        const contest = yield* contests.findById(path.contestId)
        if (Option.isNone(contest)) {
          return yield* Effect.fail(new NotFound())
        }
        const repo = yield* ArtifactRepo
        const all = yield* repo.listByContest(path.contestId)
        // filter しない。生 storagePath だけは公開 list と同様に落とす。
        return all.map(toWireArtifact)
      }).pipe(Effect.orDie)
    )
    .handleRaw("downloadArtifact", ({ path }) =>
      Effect.gen(function* () {
        const repo = yield* ArtifactRepo
        const found = yield* repo.findById(path.artifactId)
        if (Option.isNone(found) || found.value.kind === "snapshot") {
          // snapshot は URL 存在自体を隠すため 404 に落とす。
          return HttpServerResponse.empty({ status: 404 })
        }
        const artifact = found.value
        const port = yield* BackupPort
        const bytes = yield* port.readArtifact(artifact.storagePath).pipe(
          Effect.catchTag("BackupError", (e) =>
            // review round 2 finding 2: BackupError を orDie で 500 に潰さず、
            // source_missing (artifact 行はあるがファイルは失われた) は 404 に、
            // それ以外の I/O 系は 503 (provider 一時障害と同型の可用性エラー) に
            // マップする。生 detail は response に載せない (path が漏れる恐れ)。
            Effect.succeed(
              HttpServerResponse.empty({ status: e.reason === "source_missing" ? 404 : 503 })
            )
          )
        )
        if (!(bytes instanceof Uint8Array)) {
          return bytes
        }
        const contentType =
          artifact.kind === "scoreboard" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8"
        return HttpServerResponse.uint8Array(bytes, {
          headers: {
            "content-type": contentType,
            "cache-control": "public, max-age=60"
          }
        })
      }).pipe(Effect.orDie)
    )
    .handleRaw("downloadAdminArtifact", ({ path }) =>
      Effect.gen(function* () {
        const repo = yield* ArtifactRepo
        const found = yield* repo.findById(path.artifactId)
        if (Option.isNone(found)) {
          return HttpServerResponse.empty({ status: 404 })
        }
        const artifact = found.value
        const port = yield* BackupPort
        const bytes = yield* port.readArtifact(artifact.storagePath).pipe(
          Effect.catchTag("BackupError", (e) =>
            Effect.succeed(
              HttpServerResponse.empty({ status: e.reason === "source_missing" ? 404 : 503 })
            )
          )
        )
        if (!(bytes instanceof Uint8Array)) {
          return bytes
        }
        const contentType =
          artifact.kind === "scoreboard"
            ? "application/json; charset=utf-8"
            : artifact.kind === "scoreboard_csv"
              ? "text/csv; charset=utf-8"
              : "application/vnd.sqlite3"
        return HttpServerResponse.uint8Array(bytes, {
          headers: {
            "content-type": contentType,
            "cache-control": "no-store"
          }
        })
      }).pipe(Effect.orDie)
    )
    .handle("verifyArtifactChecksum", ({ path, payload }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const a = yield* verifyArtifactChecksum({
          artifactId: path.artifactId,
          expectedSha256: payload.sha256,
          now
        })
        return toWireArtifact(a)
      }).pipe(
        Effect.catchTags({
          ArtifactNotFound: () => Effect.fail(new NotFound()),
          ArtifactChecksumMismatch: (e) =>
            Effect.fail(new ArtifactChecksumMismatch({ expected: e.expected, actual: e.actual }))
        }),
        Effect.orDie
      )
    )
    .handle("requestContestFinalize", ({ path, payload }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const contests = yield* ContestRepo
        const found = yield* contests.findById(path.contestId)
        if (Option.isNone(found)) {
          return yield* Effect.fail(new NotFound())
        }
        if (found.value.revision !== payload.expectedRevision) {
          return yield* Effect.fail(
            new ContestRevisionConflict({
              expected: payload.expectedRevision,
              actual: found.value.revision
            })
          )
        }
        const op = yield* requestFinalization({
          contestId: path.contestId,
          actor: { kind: "admin", userId: user.id }
        })
        return {
          ...op,
          sanitizedError: Option.getOrNull(op.sanitizedError),
          startedAt: Option.getOrNull(op.startedAt),
          finishedAt: Option.getOrNull(op.finishedAt)
        }
      }).pipe(
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          InvalidContestTransition: (e) =>
            Effect.fail(new InvalidContestTransition({ from: e.from as never, to: e.to as never })),
          OperationInProgress: () => Effect.fail(new OperationalContestConflict())
        }),
        Effect.orDie
      )
    )
    .handle("requestContestArchive", ({ path }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const op = yield* requestLegacyArchive({
          contestId: path.contestId,
          actorUserId: user.id
        })
        return {
          ...op,
          sanitizedError: Option.getOrNull(op.sanitizedError),
          startedAt: Option.getOrNull(op.startedAt),
          finishedAt: Option.getOrNull(op.finishedAt)
        }
      }).pipe(
        Effect.catchTags({
          ContestNotFound: () => Effect.fail(new NotFound()),
          InvalidArchiveState: (e) => Effect.fail(new InvalidArchiveState({ status: e.status })),
          OperationInProgress: () => Effect.fail(new OperationalContestConflict())
        }),
        Effect.orDie
      )
    )
)
