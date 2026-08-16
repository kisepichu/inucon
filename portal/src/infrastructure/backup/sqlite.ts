import { createHash } from "node:crypto"
import { createReadStream, promises as fs } from "node:fs"
import { mkdirSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import Database from "better-sqlite3"
import { Config, Effect, Layer } from "effect"
import type { ArtifactWriteResult } from "../../application/ports.js"
import { BackupError, BackupPort } from "../../application/ports.js"

// Task 10 + Task 11: BackupPortLive。canonical `BACKUP_PATH` beneath which
// server creates archive artifacts (readiness probe + snapshot / scoreboard の
// write / read の唯一の I/O 境界)。
//
// probe (Task 10) は次の順で検査する:
//   1. BACKUP_PATH env が設定されていること (未設定は not_configured で fail)。
//   2. resolve 後の絶対パスが存在し、directory であること。
//   3. 現在プロセスがそのディレクトリに書き込めること: server-generated な
//      隠しファイル名 (`.probe-<pid>-<timestamp>`) を beneath BACKUP_PATH に
//      create → fsync → delete する。fsync まで通れば OS レベルで write 権限が
//      あることが保証される。テストは残骸が残らないことを検証する。
//
// snapshot / writeArtifact / readArtifact (Task 11):
//   - snapshot は better-sqlite3 の online backup API を使う。同 process で
//     動く SqlClient が書き込み中でも SQLite の shared journal を通じて
//     読み取り一貫性のあるコピーが取れる (WAL/rollback journal のどちらでも)。
//   - すべてのファイル出力パスは `resolveWithinBackupRoot(root, subpath)` で
//     組み立て、resolve 後に「root(canonical) + sep」の prefix でなければ
//     destination_outside_root で fail する。API に渡された subpath / kind は
//     server 側で組み立てるため、ここに request-derived な値は入らない。
//
// review 注記 (Task 10): fs 呼び出しは fs.promises (libuv thread pool 越しに
// async) を使う。同 process で走る Effect.all(readiness checks) と HTTP fiber
// が event loop を共有しているため、fsyncSync のような sync-blocking API は
// 避ける (network-mounted BACKUP_PATH で数百 ms 塞ぐ懸念)。

const CANARY_PREFIX = ".probe-"

// Node の fs 例外は Error 互換で `code?: string` を持つが、TypeScript の
// 標準型では `unknown` として来る。inline cast を避けるため runtime narrowing
// で code を取り出す小ヘルパを置く(unknown → string | null)。
const codeOf = (cause: unknown): string | null => {
  if (typeof cause !== "object" || cause === null) return null
  if (!("code" in cause)) return null
  const raw = (cause as Record<string, unknown>).code
  return typeof raw === "string" ? raw : null
}

// root(canonical)の下だけを許す絶対パスを組み立てる。resolve(subpath) の結果が
// canonical root + sep で始まらない場合は `destination_outside_root` で fail
// する。同 helper を snapshot / writeArtifact / readArtifact で共用し、
// path traversal 対策を「唯一の関門」に閉じ込める。
const resolveWithinRoot = (root: string, subpath: string): { readonly root: string; readonly resolved: string } => {
  const canonicalRoot = resolve(root)
  const candidate = resolve(canonicalRoot, subpath)
  const guard = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep
  if (candidate !== canonicalRoot && !candidate.startsWith(guard)) {
    throw new BackupError({
      reason: "destination_outside_root",
      detail: "destination resolves outside BACKUP_PATH"
    })
  }
  return { root: canonicalRoot, resolved: candidate }
}

// async runProbe。fs.promises で fsync を含む全 op が libuv thread pool 越し
// (Node.js 主 event loop を塞がない)。BackupError.reason に応じて分岐し
// throw 側は toBackupError で包む契約は同じ。
const runProbe = async (rawRoot: string): Promise<void> => {
  const root = resolve(rawRoot)

  let stat
  try {
    stat = await fs.stat(root)
  } catch (cause) {
    throw new BackupError({
      reason: "path_missing",
      detail: `BACKUP_PATH does not exist: ${codeOf(cause) ?? "ENOENT"}`
    })
  }
  if (!stat.isDirectory()) {
    throw new BackupError({
      reason: "path_not_directory",
      detail: "BACKUP_PATH is not a directory"
    })
  }

  const canary = join(root, `${CANARY_PREFIX}${process.pid}-${Date.now()}`)

  let handle
  try {
    handle = await fs.open(canary, "w", 0o600)
  } catch (cause) {
    throw new BackupError({
      reason: "not_writable",
      detail: `open failed: ${codeOf(cause) ?? "EACCES"}`
    })
  }
  try {
    await handle.write("")
    await handle.sync()
  } catch (cause) {
    try {
      await handle.close()
    } catch {
      // preserve fsync failure
    }
    try {
      await fs.unlink(canary)
    } catch {
      // best-effort
    }
    throw new BackupError({
      reason: "canary_failed",
      detail: `fsync failed: ${codeOf(cause) ?? "EIO"}`
    })
  }
  try {
    await handle.close()
  } catch (cause) {
    try {
      await fs.unlink(canary)
    } catch {
      // ignore
    }
    throw new BackupError({
      reason: "canary_failed",
      detail: `close failed: ${codeOf(cause) ?? "EIO"}`
    })
  }
  try {
    await fs.unlink(canary)
  } catch (cause) {
    throw new BackupError({
      reason: "canary_failed",
      detail: `unlink failed: ${codeOf(cause) ?? "EIO"}`
    })
  }
}

const toBackupError = (cause: unknown): BackupError =>
  cause instanceof BackupError
    ? cause
    : new BackupError({
        reason: "io_error",
        detail: `unexpected error: ${String(cause)}`
      })

// contest ごとの artifact 出力先。edition は監査容易性のため path に含める
// (`e<edition>` prefix)。既存 file はここでは触らない: writeArtifact は
// 上書き前に unlink し、createSnapshot は destination_exists を返す(呼び出し
// 側 finalization.ts が upsert 経由で ArtifactRepo 行を差し替える都合、この
// 関数の副作用は「path を計算するだけ」に限定する)。
const artifactRelativePath = (args: {
  readonly contestId: string
  readonly edition: number
  readonly filename: string
}): string => `contests/${args.contestId}/e${args.edition}/${args.filename}`

const kindFilename = (kind: "scoreboard" | "scoreboard_csv" | "snapshot"): string => {
  switch (kind) {
    case "scoreboard":
      return "scoreboard.json"
    case "scoreboard_csv":
      return "scoreboard.csv"
    case "snapshot":
      return "snapshot.sqlite"
  }
}

// bytes を root 下 subpath に atomic 相当で書き込む(上書き)。SHA-256 + サイズ
// を返す。scoreboard JSON/CSV は同 kind の regenerate で in-place 上書きする
// 想定なので、既存 file が居ても throw しない(spec: 「regenerate は in-place」)。
const writeBytes = async (
  root: string,
  subpath: string,
  bytes: Uint8Array
): Promise<ArtifactWriteResult> => {
  const { resolved } = resolveWithinRoot(root, subpath)
  try {
    await fs.mkdir(dirname(resolved), { recursive: true, mode: 0o700 })
  } catch (cause) {
    throw new BackupError({
      reason: "not_writable",
      detail: `mkdir failed: ${codeOf(cause) ?? "EACCES"}`
    })
  }
  // tmp → rename で atomic 上書き。fsync まで通してから rename する
  // (crash 後に空/破損した artifact が残らないよう)。
  const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`
  let handle
  try {
    handle = await fs.open(tmp, "w", 0o600)
  } catch (cause) {
    throw new BackupError({
      reason: "not_writable",
      detail: `open failed: ${codeOf(cause) ?? "EACCES"}`
    })
  }
  try {
    await handle.write(bytes)
    await handle.sync()
  } catch (cause) {
    try {
      await handle.close()
    } catch {
      // preserve write failure
    }
    try {
      await fs.unlink(tmp)
    } catch {
      // best-effort
    }
    throw new BackupError({
      reason: "io_error",
      detail: `write failed: ${codeOf(cause) ?? "EIO"}`
    })
  }
  await handle.close()
  try {
    await fs.rename(tmp, resolved)
  } catch (cause) {
    try {
      await fs.unlink(tmp)
    } catch {
      // ignore
    }
    throw new BackupError({
      reason: "io_error",
      detail: `rename failed: ${codeOf(cause) ?? "EIO"}`
    })
  }
  const stat = await fs.stat(resolved)
  const sha = createHash("sha256").update(bytes).digest("hex")
  return { storagePath: resolved, sha256: sha, sizeBytes: stat.size }
}

const readBytes = async (root: string, storagePath: string): Promise<Uint8Array> => {
  // resolve 後に root 内にあることだけを検証する。storagePath は ArtifactRepo
  // からのみ来る前提だが、防御的に必ず guard を通す。
  const canonicalRoot = resolve(root)
  const canonical = resolve(storagePath)
  const guard = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep
  if (canonical !== canonicalRoot && !canonical.startsWith(guard)) {
    throw new BackupError({
      reason: "destination_outside_root",
      detail: "storagePath resolves outside BACKUP_PATH"
    })
  }
  try {
    const buf = await fs.readFile(canonical)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } catch (cause) {
    const code = codeOf(cause)
    if (code === "ENOENT") {
      throw new BackupError({ reason: "source_missing", detail: `ENOENT: ${canonical}` })
    }
    throw new BackupError({
      reason: "io_error",
      detail: `read failed: ${code ?? "EIO"}`
    })
  }
}

// online backup 経由で portal DB を snapshot する。source (portal DB path) は
// DB_PATH env(SqlLive と同じ既定 "data/portal.db")を使う。destination は
// server-generated `snapshot.sqlite`。既存があると destination_exists にする
// (snapshot は必ず「一度きり」書き出す、次回は operator が verify + 上書き
// 前に旧ファイル削除して再実行する — spec: 「refusing an existing destination」
// は CLI 側で強制、Live 側は overwrite=false を守るために unlink→backup にする)。
// review round 3 finding 1 (HIGH — data-loss): unlink → backup は atomic では
// なく、backup 途中で失敗すると旧 snapshot が失われた状態で ArtifactRepo 行が
// stale な path を指す。writeBytes と同じ tmp → rename パターンに揃える。
//
// 手順:
//   1. tmp (`${resolved}.${pid}.${ts}.tmp`) に .backup() を書く。
//   2. tmp が完成した SHA-256 を stream で計算(round 1 finding 2 の踏襲)。
//   3. tmp を resolved へ atomic rename(既存があっても上書き)。
//   4. tmp が残ってしまった場合(rename 前の失敗)は unlink で片付ける。
// これで backup 失敗時は旧 snapshot が丸ごと残り、失敗経路の観測性も維持できる。
const runSnapshot = async (args: {
  readonly root: string
  readonly source: string
  readonly subpath: string
}): Promise<ArtifactWriteResult> => {
  if (resolve(args.source) === resolve(args.root)) {
    // 万一 DB_PATH と BACKUP_PATH が一致していたら壊す前に落とす。
    throw new BackupError({
      reason: "io_error",
      detail: "DB_PATH must not equal BACKUP_PATH"
    })
  }
  const { resolved } = resolveWithinRoot(args.root, args.subpath)
  try {
    await fs.mkdir(dirname(resolved), { recursive: true, mode: 0o700 })
  } catch (cause) {
    throw new BackupError({
      reason: "not_writable",
      detail: `mkdir failed: ${codeOf(cause) ?? "EACCES"}`
    })
  }
  const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`
  // 万一残っている前回の tmp は削除する(pid 衝突は稀だが同 process の同 ms 内
  // の 2 回目呼び出しで衝突しうるので unlink を先行させる)。ENOENT は無視。
  try {
    await fs.unlink(tmp)
  } catch (cause) {
    if (codeOf(cause) !== "ENOENT") {
      throw new BackupError({
        reason: "io_error",
        detail: `unlink stale tmp failed: ${codeOf(cause) ?? "EIO"}`
      })
    }
  }
  // source DB を新規に開き .backup() を呼ぶ。better-sqlite3 の .backup() は
  // SQLite の online backup API を非同期で実行する Promise を返す(進捗
  // pump)。fileMustExist=true にすることで、DB 未初期化 (migration 前) の
  // 誤呼び出しを source_missing に落とす。
  let src: Database.Database
  try {
    src = new Database(args.source, { fileMustExist: true, readonly: true })
  } catch (cause) {
    const code = codeOf(cause)
    if (code === "ENOENT") {
      throw new BackupError({ reason: "source_missing", detail: `ENOENT: ${args.source}` })
    }
    throw new BackupError({
      reason: "io_error",
      detail: `open source failed: ${code ?? String(cause)}`
    })
  }
  try {
    await src.backup(tmp)
  } catch (cause) {
    // tmp を片付けてから fail する(旧 snapshot は resolved に残っている)。
    try {
      await fs.unlink(tmp)
    } catch {
      // best-effort
    }
    throw new BackupError({
      reason: "io_error",
      detail: `backup failed: ${String(cause)}`
    })
  } finally {
    src.close()
  }
  // Review round 1 finding 2: SHA-256 は stream で計算する。tmp をハッシュ
  // 対象にすることで、rename 後の resolved で 2 回目 stat/read する必要が
  // ない(rename 前後で bytes は同一)。
  let sha256Hex: string
  try {
    sha256Hex = await new Promise<string>((resolveHash, rejectHash) => {
      const hasher = createHash("sha256")
      const stream = createReadStream(tmp)
      stream.on("data", (chunk) => hasher.update(chunk))
      stream.on("end", () => resolveHash(hasher.digest("hex")))
      stream.on("error", rejectHash)
    })
  } catch (cause) {
    try {
      await fs.unlink(tmp)
    } catch {
      // best-effort
    }
    throw new BackupError({
      reason: "io_error",
      detail: `hash failed: ${String(cause)}`
    })
  }
  // atomic 差し替え。rename が失敗すれば tmp を片付けて旧 snapshot を残す。
  try {
    await fs.rename(tmp, resolved)
  } catch (cause) {
    try {
      await fs.unlink(tmp)
    } catch {
      // ignore
    }
    throw new BackupError({
      reason: "io_error",
      detail: `rename failed: ${codeOf(cause) ?? "EIO"}`
    })
  }
  const stat = await fs.stat(resolved)
  return { storagePath: resolved, sha256: sha256Hex, sizeBytes: stat.size }
}

// BACKUP_PATH は必須(未設定なら probe が not_configured で fail する)。既定値を
// 与えないのは、production で dev fallback の canonical 外パスに書き込む事故を
// 起こさないため。deploy manifest (Task 11) が `/backups` を明示する。
// Config 側の ConfigError は Layer 構築失敗にせず「値が無かった = 空文字」に
// 落として probe が not_configured を返す (readiness の 1 key が fail するだけで
// HTTP サーバー自体は起動する)。
export const BackupPortLive: Layer.Layer<BackupPort> = Layer.effect(
  BackupPort,
  Effect.gen(function* () {
    const rawBackup = yield* Effect.orElseSucceed(Config.string("BACKUP_PATH"), () => "")
    const rawSource = yield* Effect.orElseSucceed(Config.string("DB_PATH"), () => "data/portal.db")
    const notConfigured: Effect.Effect<never, BackupError> = Effect.fail(
      new BackupError({ reason: "not_configured", detail: "BACKUP_PATH is not set" })
    )
    return {
      probe: Effect.gen(function* () {
        if (rawBackup === "") return yield* notConfigured
        yield* Effect.tryPromise({ try: () => runProbe(rawBackup), catch: toBackupError })
      }),
      createSnapshot: (args) =>
        Effect.gen(function* () {
          if (rawBackup === "") return yield* notConfigured
          const subpath = artifactRelativePath({
            contestId: args.contestId as unknown as string,
            edition: args.edition,
            filename: kindFilename("snapshot")
          })
          return yield* Effect.tryPromise({
            try: () => runSnapshot({ root: rawBackup, source: rawSource, subpath }),
            catch: toBackupError
          })
        }),
      writeArtifact: (args) =>
        Effect.gen(function* () {
          if (rawBackup === "") return yield* notConfigured
          const subpath = artifactRelativePath({
            contestId: args.contestId as unknown as string,
            edition: args.edition,
            filename: kindFilename(args.kind)
          })
          return yield* Effect.tryPromise({
            try: () => writeBytes(rawBackup, subpath, args.bytes),
            catch: toBackupError
          })
        }),
      readArtifact: (storagePath) =>
        Effect.gen(function* () {
          if (rawBackup === "") return yield* notConfigured
          return yield* Effect.tryPromise({
            try: () => readBytes(rawBackup, storagePath),
            catch: toBackupError
          })
        })
    }
  })
)

// テスト時のみ利用する pure entrypoint。任意の root に対して同じ検査を走らせ、
// 成功時は undefined、失敗時は BackupError で fail する。probeAt を通じて
// 「env を差し替えずに root を差し替えたい」テスト側から利用する。
export const probeAt = (root: string): Effect.Effect<void, BackupError> =>
  Effect.tryPromise({
    try: () => runProbe(root),
    catch: toBackupError
  })

// Task 11 のテストが「実 FS に対して snapshot を作り、SHA-256 が一致する」ことを
// 確認するために使う pure entrypoint。DB_PATH と BACKUP_PATH の env を触らず、
// 引数で source / root / subpath を受け取る。
export const snapshotAt = (args: {
  readonly root: string
  readonly source: string
  readonly subpath: string
}): Effect.Effect<ArtifactWriteResult, BackupError> =>
  Effect.tryPromise({
    try: () => runSnapshot(args),
    catch: toBackupError
  })

// Task 11: scoreboard JSON/CSV の実 FS write を pure entrypoint 越しに実行する
// (テストから env に触らずに検証できる)。
export const writeArtifactAt = (args: {
  readonly root: string
  readonly subpath: string
  readonly bytes: Uint8Array
}): Effect.Effect<ArtifactWriteResult, BackupError> =>
  Effect.tryPromise({
    try: () => writeBytes(args.root, args.subpath, args.bytes),
    catch: toBackupError
  })

// Task 11: read 経路。download handler は必ずこの port 越しにファイルを読む
// (request からの生 path を渡さない; storagePath は ArtifactRepo から解決した
// ものだけ通る)。
export const readArtifactAt = (args: {
  readonly root: string
  readonly storagePath: string
}): Effect.Effect<Uint8Array, BackupError> =>
  Effect.tryPromise({
    try: () => readBytes(args.root, args.storagePath),
    catch: toBackupError
  })

// ディレクトリを親ごと作るヘルパー。probe には使わない (probe は「今のルートが
// そのまま使えるか」を検査するのが目的で、mkdir で環境を修正するのは probe の
// 責務ではない)。 mkdir は起動シーケンスの限られたタイミングでしか呼ばず、
// 大量並列に走らないため sync で十分 (fsync のような device flush を伴わない)。
export const ensureBackupDirectory = (path: string): Effect.Effect<void, BackupError> =>
  Effect.try({
    try: () => {
      mkdirSync(path, { recursive: true, mode: 0o700 })
    },
    catch: (cause) =>
      new BackupError({
        reason: "not_writable",
        detail: `mkdir failed: ${codeOf(cause) ?? "EACCES"}`
      })
  })
