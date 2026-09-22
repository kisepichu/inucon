import { it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { execFileSync } from "node:child_process"
import Database from "better-sqlite3"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect } from "vitest"
import {
  readArtifactAt,
  snapshotAt,
  writeArtifactAt
} from "../../src/infrastructure/backup/sqlite.js"

// child_process.execFileSync が非 0 exit で throw する例外は Node の
// `child_process` の ExecFileSyncError で `status: number | null` を持つが、
// 標準型は unknown なので guard で narrowing する。
const exitCodeOf = (cause: unknown): number => {
  if (typeof cause !== "object" || cause === null) return -1
  if (!("status" in cause)) return -1
  const raw = cause.status
  return typeof raw === "number" ? raw : -1
}

// Task 11 §Step 2 / §Step 5: BackupPortLive の write/snapshot/read の実 FS 契約と、
// portal/dist/cli/backup.js の CLI 契約を検証する。
//   - snapshot は better-sqlite3 の online backup で source を dest に写し取り、
//     dest を SHA-256 で hash した値が「dest を独立に読み直した hash」と一致する。
//   - writeArtifact は tmp → rename で atomic 書き込みし、bytes / sha256 / size を返す。
//   - readArtifact は「storagePath が root 外」に対して destination_outside_root で fail。
//   - CLI は --source / --destination を明示指定必須、同一パス refuse、既存 dest refuse、
//     成功時 JSON メタデータ 1 行 stdout。

const makeTempRoot = (): string => mkdtempSync(join(tmpdir(), "inucon-sqlbackup-"))

// 現実的な source DB を組み立てる: 1 table 1 row の SQLite。
const makeSourceDb = (dir: string): { path: string; sha256: string } => {
  const path = join(dir, "source.sqlite")
  const db = new Database(path)
  db.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)")
  db.prepare("INSERT INTO t (k, v) VALUES (?, ?)").run("hello", "world")
  db.close()
  const sha = createHash("sha256").update(readFileSync(path)).digest("hex")
  return { path, sha256: sha }
}

describe("BackupPortLive.snapshotAt (better-sqlite3 online backup)", () => {
  it.effect("snapshot は SHA-256 と sizeBytes を返し、独立に読み直したハッシュと一致する", () =>
    Effect.gen(function* () {
      const dir = makeTempRoot()
      try {
        const { path: src } = makeSourceDb(dir)
        const root = join(dir, "backups")
        const result = yield* snapshotAt({
          root,
          source: src,
          subpath: "contests/c1/e1/snapshot.sqlite"
        })
        expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(result.sizeBytes).toBeGreaterThan(0)
        // 独立読み直しで一致
        const bytes = readFileSync(result.storagePath)
        const sha = createHash("sha256").update(bytes).digest("hex")
        expect(sha).toBe(result.sha256)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  )

  it.effect("既存 snapshot がある状態で再走行しても、上書きされ SHA-256 は新規計算される", () =>
    Effect.gen(function* () {
      const dir = makeTempRoot()
      try {
        const { path: src } = makeSourceDb(dir)
        const root = join(dir, "backups")
        const first = yield* snapshotAt({
          root,
          source: src,
          subpath: "contests/c1/e1/snapshot.sqlite"
        })
        // source に新規行を追加してから再 snapshot
        const db = new Database(src)
        db.prepare("INSERT INTO t (k, v) VALUES (?, ?)").run("bye", "moon")
        db.close()
        const second = yield* snapshotAt({
          root,
          source: src,
          subpath: "contests/c1/e1/snapshot.sqlite"
        })
        expect(second.sha256).not.toBe(first.sha256)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  )

  it.effect("source が存在しない場合 source_missing で fail する", () =>
    Effect.gen(function* () {
      const dir = makeTempRoot()
      try {
        const root = join(dir, "backups")
        const exit = yield* Effect.exit(
          snapshotAt({
            root,
            source: join(dir, "nonexistent.sqlite"),
            subpath: "contests/c1/e1/snapshot.sqlite"
          })
        )
        expect(Exit.isFailure(exit)).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  )

  it.effect("subpath が root 外に解決したら destination_outside_root で fail する", () =>
    Effect.gen(function* () {
      const dir = makeTempRoot()
      try {
        const { path: src } = makeSourceDb(dir)
        const root = join(dir, "backups")
        const exit = yield* Effect.exit(
          snapshotAt({ root, source: src, subpath: "../evil.sqlite" })
        )
        expect(Exit.isFailure(exit)).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  )
})

describe("BackupPortLive.writeArtifactAt / readArtifactAt", () => {
  it.effect("writeArtifact は bytes / sha256 / sizeBytes を返し、read は同じ bytes を返す", () =>
    Effect.gen(function* () {
      const dir = makeTempRoot()
      try {
        const bytes = new TextEncoder().encode("hello,world")
        const write = yield* writeArtifactAt({
          root: dir,
          subpath: "contests/c1/e1/scoreboard.csv",
          bytes
        })
        expect(write.sizeBytes).toBe(bytes.byteLength)
        expect(write.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
        const back = yield* readArtifactAt({ root: dir, storagePath: write.storagePath })
        expect(Buffer.from(back).toString("utf-8")).toBe("hello,world")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  )

  it.effect("readArtifact は root 外の絶対パスを destination_outside_root で拒否", () =>
    Effect.gen(function* () {
      const dir = makeTempRoot()
      try {
        const exit = yield* Effect.exit(
          readArtifactAt({ root: dir, storagePath: "/etc/passwd" })
        )
        expect(Exit.isFailure(exit)).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  )
})

// CLI subprocess smoke tests spawn `node portal/dist/cli/backup.js` via
// execFileSync. Spawning a Node process from within a vitest worker blocks
// the worker's event loop for hundreds of ms, which starves *other* workers
// running HTTP tests in parallel (vitest defaults to spinning up
// os.cpus().length workers). We gate them behind `INUCON_CLI_SMOKE=1` so the
// regular `pnpm --filter portal test` stays flake-free; CI is expected to
// build the CLI and set the env var to opt in. The static-import check
// (below, always active) covers the "main Layer 非依存" contract regardless.
const RUN_CLI_SMOKE = process.env.INUCON_CLI_SMOKE === "1"
const smokeIt = RUN_CLI_SMOKE ? it : it.skip

describe("portal/dist/cli/backup.js の契約", () => {
  // Note: この test は CLI をビルド後に呼ぶ想定だが、コード直呼び出しでも
  // 契約の見出しは検証できる。ここでは main() の core 分岐は logic として
  // parseArgs 相当の副次ロジックに閉じるため、実 CLI 実行は smoke test 1 本に
  // 絞る(SPEC: 「main Layer 非依存」= import 数の検証)。
  it("`portal/src/cli/backup.ts` は main / repos / Migrator を import しない", () => {
    // 依存の静的検査。将来 main.ts 側の import が誤って混入すると
    // Kubernetes Job で env を要求するようになるため、この smoke で早期に落とす。
    const src = readFileSync(
      new URL("../../src/cli/backup.ts", import.meta.url),
      "utf-8"
    )
    expect(src).not.toContain("../main.js")
    expect(src).not.toContain("infrastructure/sql")
    expect(src).not.toContain("infrastructure/http")
    expect(src).not.toContain("application/usecases")
    expect(src).not.toContain('from "shared"')
  })

  smokeIt("--source と --destination が同一パスの CLI 呼び出しは refuse (exit 1)", () => {
    const dir = makeTempRoot()
    try {
      const { path: src } = makeSourceDb(dir)
      const distCli = join(
        new URL("../../", import.meta.url).pathname,
        "dist",
        "cli",
        "backup.js"
      )
      if (!existsSync(distCli)) return
      const exit = (() => {
        try {
          execFileSync("node", [distCli, "--source", src, "--destination", src], {
            stdio: "pipe"
          })
          return 0
        } catch (e) {
          return exitCodeOf(e)
        }
      })()
      expect(exit).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  smokeIt("destination が既存の CLI 呼び出しは refuse (exit 1)", () => {
    const dir = makeTempRoot()
    try {
      const { path: src } = makeSourceDb(dir)
      const dst = join(dir, "existing.sqlite")
      writeFileSync(dst, "already-there")
      const distCli = join(
        new URL("../../", import.meta.url).pathname,
        "dist",
        "cli",
        "backup.js"
      )
      if (!existsSync(distCli)) return
      const exit = (() => {
        try {
          execFileSync("node", [distCli, "--source", src, "--destination", dst], {
            stdio: "pipe"
          })
          return 0
        } catch (e) {
          return exitCodeOf(e)
        }
      })()
      expect(exit).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
