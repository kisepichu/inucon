#!/usr/bin/env node
// Task 11 §Step 5: 非サーバー CLI エントリポイント。pre-migration Kubernetes Job
// (Task 15) が portal DB のバックアップを取るために使う。portal の main Layer
// (Migrator / Repos を Layer.provide するチェーン) に一切依存しない — 依存を
// 引き込むと Job 側で env(GITHUB_CLIENT_ID 等) を要求してしまうため、この
// スクリプトは better-sqlite3 と node 標準モジュールだけを使う。
//
// 契約:
//   - `--source <path>` と `--destination <path>` を明示指定する。
//     どちらか欠けたら usage を printErr して exit 1。
//   - source と destination が同じパスに解決したら refuse (壊す前に落とす)。
//   - destination が既に存在したら refuse (spec: 「refusing an existing
//     destination」— CLI では上書き禁止で、operator に明示削除を強制する)。
//   - 成功時 stdout に JSON メタデータ 1 行だけを出す(監査/自動化用)。
//     `{ storagePath, sha256, sizeBytes, sourcePath }`
//   - 失敗は stderr に短い 1 行(reason: detail)を書いて exit 1。
//
// このファイルは `tsc -p tsconfig.json` で `portal/dist/cli/backup.js` にコンパイル
// される。Kubernetes Job の CMD は `node portal/dist/cli/backup.js` 経由でこれを
// 呼ぶ想定。

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import Database from "better-sqlite3"

interface Args {
  readonly source: string
  readonly destination: string
}

const usage = (): never => {
  process.stderr.write(
    "usage: node portal/dist/cli/backup.js --source <path> --destination <path>\n"
  )
  process.exit(1)
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
  let source: string | null = null
  let destination: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i]
    const next = argv[i + 1]
    if (cur === "--source" && next !== undefined) {
      source = next
      i++
    } else if (cur === "--destination" && next !== undefined) {
      destination = next
      i++
    }
  }
  if (source === null || destination === null) return usage()
  return { source, destination }
}

const failWith = (reason: string, detail: string): never => {
  process.stderr.write(`${reason}: ${detail}\n`)
  process.exit(1)
}

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const srcResolved = resolve(args.source)
  const dstResolved = resolve(args.destination)

  if (srcResolved === dstResolved) {
    failWith("source_equals_destination", srcResolved)
  }
  if (!existsSync(srcResolved)) {
    failWith("source_missing", srcResolved)
  }
  if (existsSync(dstResolved)) {
    failWith("destination_exists", dstResolved)
  }

  try {
    mkdirSync(dirname(dstResolved), { recursive: true, mode: 0o700 })
  } catch (cause) {
    failWith("mkdir_failed", String(cause))
  }

  let src: Database.Database
  try {
    src = new Database(srcResolved, { fileMustExist: true, readonly: true })
  } catch (cause) {
    failWith("open_source_failed", String(cause))
    return
  }
  try {
    await src.backup(dstResolved)
  } catch (cause) {
    failWith("backup_failed", String(cause))
  } finally {
    src.close()
  }

  const buf = readFileSync(dstResolved)
  const sha = createHash("sha256").update(buf).digest("hex")
  const stat = statSync(dstResolved)
  const meta = {
    storagePath: dstResolved,
    sourcePath: srcResolved,
    sha256: sha,
    sizeBytes: stat.size
  }
  process.stdout.write(`${JSON.stringify(meta)}\n`)
}

main().catch((cause) => {
  failWith("unexpected_error", String(cause))
})
