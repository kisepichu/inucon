import { HttpBody, HttpClient } from "@effect/platform"
import { it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { describe, expect } from "vitest"
import { ArtifactId, ContestId } from "../../src/domain/ids.js"
import { Artifact as ArtifactDomain } from "../../src/domain/artifact.js"
import { ArtifactRepo, ContestRepo } from "../../src/application/ports.js"
import { asAdmin, TestLayer } from "../support/apiTestHelpers.js"
import { makeContest } from "../support/factories.js"
import { login } from "../support/login.js"

// Task 11 §Step 2: artifacts group HTTP contract。
//
// - GET /api/contests/:contestId/artifacts は公開経路。scoreboard/scoreboard_csv
//   のみを返し、snapshot は除外する。存在しない contest / canceled は 404。
// - GET /api/admin/contests/:contestId/artifacts は AdminOnly。snapshot を含む
//   全 kind を返す(Archive タブの off-host verify 導線が snapshot 行を必要と
//   するため)。canceled でも 404 にしない。
// - POST /api/admin/artifacts/:artifactId/verify は AdminOnly。sha256 一致で
//   200 + off_host_status='verified'、不一致で 409。
// - POST /api/admin/contests/:contestId/archive は AdminOnly。finished
//   Contest は 200(Operation を返す)、非ログインは 401。

const CONTEST_ID = ContestId.make("aaaaaaaa-cccc-cccc-cccc-cccccccccccc")
const CANCELED_CONTEST_ID = ContestId.make("bbbbbbbb-cccc-cccc-cccc-cccccccccccc")

const seedFinishedContest = Effect.gen(function* () {
  const contests = yield* ContestRepo
  yield* contests.create(
    makeContest({
      id: CONTEST_ID,
      edition: 1,
      status: "finished",
      scheduledStartAt: Option.some(100),
      scheduledEndAt: Option.some(200),
      accessClosesAt: Option.some(200),
      startedAt: Option.some(100),
      finalizingAt: Option.some(200),
      finishedAt: Option.some(300)
    })
  )
})

const seedArtifact = (
  kind: "scoreboard" | "scoreboard_csv" | "snapshot",
  opts: { sha256?: string; contestId?: ContestId; id?: ArtifactId } = {}
) =>
  Effect.gen(function* () {
    const repo = yield* ArtifactRepo
    const id =
      opts.id ??
      ArtifactId.make(
        kind === "scoreboard"
          ? "11111111-1111-1111-1111-111111111111"
          : kind === "scoreboard_csv"
            ? "22222222-2222-2222-2222-222222222222"
            : "33333333-3333-3333-3333-333333333333"
      )
    yield* repo.upsert(
      new ArtifactDomain({
        id,
        contestId: opts.contestId ?? CONTEST_ID,
        kind,
        storagePath: `/backups/dummy-${kind}.dat`,
        sha256: opts.sha256 ?? "ab".repeat(32),
        sizeBytes: 42,
        offHostStatus: kind === "snapshot" ? "pending" : "not_applicable",
        verifiedAt: Option.none(),
        createdAt: 1000
      })
    )
    return id
  })

const seedCanceledContest = Effect.gen(function* () {
  const contests = yield* ContestRepo
  yield* contests.create(
    makeContest({
      id: CANCELED_CONTEST_ID,
      edition: 2,
      status: "canceled",
      canceledAt: Option.some(400)
    })
  )
})

describe("GET /api/contests/:contestId/artifacts", () => {
  it.effect("scoreboard / scoreboard_csv のみが返り、snapshot は除外される", () =>
    Effect.gen(function* () {
      yield* seedFinishedContest
      yield* seedArtifact("scoreboard")
      yield* seedArtifact("scoreboard_csv")
      yield* seedArtifact("snapshot")
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/contests/${CONTEST_ID}/artifacts`)
      expect(res.status).toBe(200)
      const text = yield* res.text
      const body = JSON.parse(text) as ReadonlyArray<{ kind: string }>
      expect(body.map((a) => a.kind).sort()).toEqual(["scoreboard", "scoreboard_csv"])
      // 情報漏洩の回帰防止: snapshot の artifactId も body に出てはいけない
      // (id が漏れれば /api/artifacts/:id/download の 404 ガードだけが残る)。
      expect(text).not.toContain("33333333-3333-3333-3333-333333333333")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しない contestId は 404", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/api/contests/00000000-dead-dead-dead-000000000000/artifacts")
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("GET /api/admin/contests/:contestId/artifacts", () => {
  it.effect("cookie 無しは 401", () =>
    Effect.gen(function* () {
      yield* seedFinishedContest
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/admin/contests/${CONTEST_ID}/artifacts`)
      expect(res.status).toBe(401)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("非 admin は 403", () =>
    Effect.gen(function* () {
      yield* seedFinishedContest
      yield* seedArtifact("snapshot")
      const { cookieHeader } = yield* login({ githubLogin: "u-artifacts-nonadmin", githubId: 9100 })
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/admin/contests/${CONTEST_ID}/artifacts`, {
        headers: { cookie: cookieHeader }
      })
      expect(res.status).toBe(403)
      // 403 body に snapshot の痕跡を載せない。
      expect(yield* res.text).not.toContain("snapshot")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("admin は snapshot を含む全 kind を受け取る", () =>
    Effect.gen(function* () {
      yield* seedFinishedContest
      yield* seedArtifact("scoreboard")
      yield* seedArtifact("scoreboard_csv")
      yield* seedArtifact("snapshot")
      const { cookieHeader } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/admin/contests/${CONTEST_ID}/artifacts`, {
        headers: { cookie: cookieHeader }
      })
      expect(res.status).toBe(200)
      const text = yield* res.text
      const body = JSON.parse(text) as ReadonlyArray<{
        readonly kind: string
        readonly offHostStatus: string
      }>
      expect(body.map((a) => a.kind).sort()).toEqual(["scoreboard", "scoreboard_csv", "snapshot"])
      // off-host verify 導線が必要とするのは pending な snapshot 行。
      expect(body.find((a) => a.kind === "snapshot")?.offHostStatus).toBe("pending")
      // 公開 list と同じく生 storagePath は載せない。
      expect(text).not.toContain("/backups/")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("canceled Contest でも 200 で artifact を返す", () =>
    Effect.gen(function* () {
      yield* seedCanceledContest
      yield* seedArtifact("snapshot", {
        contestId: CANCELED_CONTEST_ID,
        id: ArtifactId.make("44444444-4444-4444-4444-444444444444")
      })
      const { cookieHeader } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(`/api/admin/contests/${CANCELED_CONTEST_ID}/artifacts`, {
        headers: { cookie: cookieHeader }
      })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as ReadonlyArray<{ kind: string }>
      expect(body.map((a) => a.kind)).toEqual(["snapshot"])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("存在しない contestId は 404", () =>
    Effect.gen(function* () {
      const { cookieHeader } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get(
        "/api/admin/contests/00000000-dead-dead-dead-000000000000/artifacts",
        { headers: { cookie: cookieHeader } }
      )
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/admin/artifacts/:artifactId/verify", () => {
  it.effect("cookie 無しは 401", () =>
    Effect.gen(function* () {
      yield* seedFinishedContest
      const id = yield* seedArtifact("snapshot")
      const client = yield* HttpClient.HttpClient
      const res = yield* client.post(`/api/admin/artifacts/${id}/verify`, {
        body: HttpBody.unsafeJson({ sha256: "ab".repeat(32) })
      })
      expect(res.status).toBe(401)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("sha256 が一致すれば 200 + offHostStatus='verified'", () =>
    Effect.gen(function* () {
      yield* seedFinishedContest
      const id = yield* seedArtifact("snapshot", { sha256: "aa".repeat(32) })
      const { cookieHeader } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.post(`/api/admin/artifacts/${id}/verify`, {
        headers: { cookie: cookieHeader },
        body: HttpBody.unsafeJson({ sha256: "aa".repeat(32) })
      })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { offHostStatus: string; verifiedAt: number | null }
      expect(body.offHostStatus).toBe("verified")
      expect(typeof body.verifiedAt).toBe("number")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("sha256 が不一致なら 409 で ArtifactChecksumMismatch を返す", () =>
    Effect.gen(function* () {
      yield* seedFinishedContest
      const id = yield* seedArtifact("snapshot", { sha256: "aa".repeat(32) })
      const { cookieHeader } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.post(`/api/admin/artifacts/${id}/verify`, {
        headers: { cookie: cookieHeader },
        body: HttpBody.unsafeJson({ sha256: "bb".repeat(32) })
      })
      expect(res.status).toBe(409)
      const body = (yield* res.json) as { _tag: string; expected: string; actual: string }
      expect(body._tag).toBe("ArtifactChecksumMismatch")
      expect(body.expected).toBe("bb".repeat(32))
      expect(body.actual).toBe("aa".repeat(32))
    }).pipe(Effect.provide(TestLayer))
  )
})

describe("POST /api/admin/contests/:contestId/archive", () => {
  it.effect("finished Contest では 200 + backup Operation を返す", () =>
    Effect.gen(function* () {
      yield* seedFinishedContest
      const { cookieHeader } = yield* asAdmin()
      const client = yield* HttpClient.HttpClient
      const res = yield* client.post(`/api/admin/contests/${CONTEST_ID}/archive`, {
        headers: { cookie: cookieHeader },
        body: HttpBody.unsafeJson({})
      })
      expect(res.status).toBe(200)
      const body = (yield* res.json) as { kind: string; status: string }
      expect(body.kind).toBe("backup")
    }).pipe(Effect.provide(TestLayer))
  )
})
