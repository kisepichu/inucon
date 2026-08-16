import { promises as fs } from "node:fs"
import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { Config, Effect, Layer } from "effect"
import { BackupError, BackupPort } from "../../application/ports.js"

// Task 10: BackupPortLive.probe。canonical `BACKUP_PATH` beneath which server
// creates archive artifacts (Task 11 で snapshot 書き込みを同 adapter に追加)。
//
// probe は次の順で検査する:
//   1. BACKUP_PATH env が設定されていること (未設定は not_configured で fail)。
//   2. resolve 後の絶対パスが存在し、directory であること。
//   3. 現在プロセスがそのディレクトリに書き込めること: server-generated な
//      隠しファイル名 (`.probe-<pid>-<timestamp>`) を beneath BACKUP_PATH に
//      create → fsync → delete する。fsync まで通れば OS レベルで write 権限が
//      あることが保証される。テストは残骸が残らないことを検証する。
//
// probe は絶対に BACKUP_PATH 外にファイルを作らない: canary パスは resolve(root)
// + basename だけを結合し、path traversal の余地を持たせない。
//
// review round 3 #2: fs 呼び出しは fs.promises (libuv thread pool 越しに async)
// を使う。同 process で走る Effect.all(readiness checks, concurrency: unbounded)
// と HTTP fiber が event loop を共有しているため、fsyncSync のような
// sync-blocking API は避ける (network-mounted BACKUP_PATH で数百 ms 塞ぐ懸念)。

// 隠しファイル prefix (dot). 通常運用中に visible にならないよう `.probe-` にする。
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

  // canary basename は resolve(root) + basename で作る。root が resolve 済みで
  // basename に "/" を含まないため、join の結果は決して root 外に出ない。
  const canary = join(root, `${CANARY_PREFIX}${process.pid}-${Date.now()}`)

  let handle
  try {
    // 0o600: 他ユーザーから読めないパーミッションで作る。0-byte で作成し、
    // fsync まで通れば OS の write ACL は満たしている。
    handle = await fs.open(canary, "w", 0o600)
  } catch (cause) {
    throw new BackupError({
      reason: "not_writable",
      detail: `open failed: ${codeOf(cause) ?? "EACCES"}`
    })
  }
  try {
    // 0-byte でも fsync するのは、ディレクトリ側の inode / journal が persisted
    // されるまで待つため (spec: "create/fsync/delete canary")。libuv 越しなので
    // event loop は塞がない (fsync 自体の I/O 完了までは他 fiber が走れる)。
    await handle.write("")
    await handle.sync()
  } catch (cause) {
    // fsync 失敗は writable でも I/O 系の一時故障の可能性がある。close 後に
    // 残骸ファイルの unlink を試み、それでも delete が通らなければ canary_failed。
    try {
      await handle.close()
    } catch {
      // close 失敗は既に握った fsync 失敗を優先して伝える。
    }
    try {
      await fs.unlink(canary)
    } catch {
      // 残骸が残っても probe 全体は fail 扱い。
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
      // ignore secondary failure
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
        reason: "canary_failed",
        detail: `unexpected error: ${String(cause)}`
      })

// BACKUP_PATH は必須(未設定なら probe が not_configured で fail する)。既定値を
// 与えないのは、production で dev fallback の canonical 外パスに書き込む事故を
// 起こさないため。deploy manifest (Task 11) が `/backups` を明示する。
// Config 側の ConfigError は Layer 構築失敗にせず「値が無かった = 空文字」に
// 落として probe が not_configured を返す (readiness の 1 key が fail するだけで
// HTTP サーバー自体は起動する)。
export const BackupPortLive: Layer.Layer<BackupPort> = Layer.effect(
  BackupPort,
  Effect.map(Effect.orElseSucceed(Config.string("BACKUP_PATH"), () => ""), (raw) => ({
    probe: Effect.gen(function* () {
      if (raw === "") {
        return yield* Effect.fail(
          new BackupError({
            reason: "not_configured",
            detail: "BACKUP_PATH is not set"
          })
        )
      }
      yield* Effect.tryPromise({
        try: () => runProbe(raw),
        catch: toBackupError
      })
    })
  }))
)

// テスト時のみ利用する pure entrypoint。任意の root に対して同じ検査を走らせ、
// 成功時は undefined、失敗時は BackupError で fail する。probeAt を通じて
// 「env を差し替えずに root を差し替えたい」テスト側から利用する。
export const probeAt = (root: string): Effect.Effect<void, BackupError> =>
  Effect.tryPromise({
    try: () => runProbe(root),
    catch: toBackupError
  })

// ディレクトリを親ごと作るヘルパー(Task 11 で snapshot 用の subdir を用意する
// 際に使う想定)。probe には使わない (probe は「今のルートがそのまま使えるか」
// を検査するのが目的で、mkdir で環境を修正するのは probe の責務ではない)。
// mkdir は起動シーケンスの限られたタイミングでしか呼ばず、大量並列に走らない
// ため sync で十分 (fsync のような device flush を伴わない)。
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
