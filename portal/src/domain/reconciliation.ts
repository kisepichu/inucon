import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import type { ContestId, InstanceId, ResourceBindingId, TeamId } from "./ids.js"
import type { InstanceStatus } from "./instance.js"

// Task 7: reconciliation の分類と canonical plan digest。ここは純粋関数のみ。
// I/O(provider inventory / repository 読み取り)は usecases/reconciliation.ts が
// 担当し、この module には副作用を一切持ち込まない。
//
// 分類は spec §Reconciliation の 6 値:
//   - in_sync:          desired と observed が一致
//   - missing:          DB/binding はあるが外部実体がない
//   - drifted:          hostname/IP/policy が観測不一致
//   - managed_orphan:   binding はあるが Instance が deleted (cleanup 済み扱い)
//   - unmanaged_orphan: 命名は inucon-team* だが binding が 1 件も無い
//   - ambiguous:        同一 hostname に複数 DNS / 未知 policy / VMID 衝突など
//
// action は plan/apply レイヤーが実行する 4 種:
//   - noop:          何もしない(in_sync)
//   - cleanup:       所有リソースを idempotent に撤収し、Instance を deleted に落とす
//   - adopt_cleanup: 観測結果から ResourceBinding を作ってから cleanup と同じ経路
//   - blocked:       操作不能(unmanaged_orphan で adopt 未確認、ambiguous 等)

export const RECONCILIATION_CLASSES = [
  "in_sync",
  "missing",
  "drifted",
  "managed_orphan",
  "unmanaged_orphan",
  "ambiguous"
] as const
export type ReconciliationClass = (typeof RECONCILIATION_CLASSES)[number]

export const RECONCILIATION_ACTIONS = ["noop", "cleanup", "adopt_cleanup", "blocked"] as const
export type ReconciliationAction = (typeof RECONCILIATION_ACTIONS)[number]

// provider inventory を hostname stem(`inucon-teamN-M`)単位に畳んだ観測。
// stem を hostname と呼ぶ。CF は "inucon-team1-1.kisen.one" などの FQDN から
// stem を取り出して observation に集約する(port 側の責務)。
// review round 7 #1: DNS record と tunnel ingress は独立に消え得るので
// count も分けて保持する(以前は route.dnsRecordIds.length だけで
// cloudflareRouteCount を作っていたため、DNS 残存 + ingress 消失 の中間状態が
// in_sync に落ちて cleanup 対象から漏れていた)。
export interface HostnameObservation {
  readonly hostname: string
  readonly proxmoxVm: Option.Option<{ readonly vmid: number; readonly status: string }>
  readonly cloudflareRouteCount: number
  readonly cloudflareIngressCount: number
  readonly cloudflareAppCount: number
}

// DB 側の desired(bindings + instances)を hostname 単位に畳んだ集合。
// review round 6: 現行 vertical slice の cleanup step は Cloudflare 側の
// binding + resource だけを削除する(Proxmox VM binding + Instance 状態遷移は
// Task 12 の cleanup Operation の担当)。convergence の判定でも step が実際に
// 消せるものだけを見る必要があるため、cloudflareBindingIds と proxmoxBindingIds
// を分けて保持する。全 binding 集合が必要な UI/監査経路は
// `bindingIds = [...cloudflareBindingIds, ...proxmoxBindingIds]` で導出する。
export interface HostnameDesired {
  readonly hostname: string
  readonly contestId: ContestId
  readonly teamId: Option.Option<TeamId>
  readonly instanceId: Option.Option<InstanceId>
  readonly instanceStatus: Option.Option<InstanceStatus>
  readonly cloudflareBindingIds: ReadonlyArray<ResourceBindingId>
  readonly proxmoxBindingIds: ReadonlyArray<ResourceBindingId>
}

export interface ReconciliationEntry {
  readonly hostname: string
  readonly classification: ReconciliationClass
  readonly action: ReconciliationAction
  // 呼び出し元 UI / 監査ログ用の非機密 reason 文字列。email / token 等は含めない。
  readonly reason: string
  readonly proxmoxVmObserved: boolean
  readonly cloudflareRouteCount: number
  readonly cloudflareIngressCount: number
  readonly cloudflareAppCount: number
  readonly bindingIds: ReadonlyArray<ResourceBindingId>
  readonly instanceId: Option.Option<InstanceId>
}

export interface ReconciliationPlan {
  readonly contestId: ContestId
  readonly contestRevision: number
  readonly planDigest: string
  readonly generatedAt: number
  readonly entries: ReadonlyArray<ReconciliationEntry>
  readonly adoptHostnames: ReadonlyArray<string>
}

// 分類の判定順(優先度が高い方から短絡評価):
//  1) 重複観測(routes>1 or apps>1) → ambiguous + blocked(adopt 済みでも apply させない)
//  2) desired 無し + 観測有り → unmanaged_orphan
//     - adopt に含まれれば adopt_cleanup、そうでなければ blocked
//  3) desired 有り + Instance が deleted 済み(binding のみ残存) → managed_orphan + cleanup
//  4) desired 有り + Proxmox VM 観測無し → missing + cleanup
//  5) desired 有り + CF 観測が期待値と食い違い(0 件) → drifted + cleanup
//  6) それ以外(desired 有り + 全観測一致) → in_sync + noop
export const classifyHostname = (args: {
  readonly observation: HostnameObservation
  readonly desired: HostnameDesired | undefined
  readonly adopted: boolean
}): ReconciliationEntry => {
  const { observation, desired, adopted } = args
  const proxmoxVmObserved = Option.isSome(observation.proxmoxVm)
  const cfBindingIds = desired?.cloudflareBindingIds ?? []
  const proxmoxBindingIds = desired?.proxmoxBindingIds ?? []
  const allBindingIds: ReadonlyArray<ResourceBindingId> = [...cfBindingIds, ...proxmoxBindingIds]
  const base = {
    hostname: observation.hostname,
    proxmoxVmObserved,
    cloudflareRouteCount: observation.cloudflareRouteCount,
    cloudflareIngressCount: observation.cloudflareIngressCount,
    cloudflareAppCount: observation.cloudflareAppCount,
    bindingIds: allBindingIds,
    instanceId: desired?.instanceId ?? Option.none<InstanceId>()
  } as const

  // review round 9 #1: ingress duplicate も ambiguous として stop する。
  // 以前は DNS/Access のみを見ていたため「DNS 1 個 + ingress 2 個 + Access
  // 1 個」の状態が in_sync に落ち、tunnel が意図せず 2 経路持ちになったまま
  // 永続化するリスクがあった(cloudflared は first-match だが、削除時に
  // 誤って新しい方だけ落ちるなど非決定的挙動を招く)。
  const duplicated =
    observation.cloudflareRouteCount > 1 ||
    observation.cloudflareIngressCount > 1 ||
    observation.cloudflareAppCount > 1
  if (duplicated) {
    return {
      ...base,
      classification: "ambiguous",
      action: "blocked",
      reason: "duplicate_provider_records"
    }
  }

  // review round 5 #1/#2: cleanup 系分類は「実際に消せる resource が残っている」
  // ときにだけ action=cleanup を返す。以前は managed_orphan/missing/drifted で
  // 無条件に cleanup を返していたため、CF resource も binding も全て消えた後の
  // 次 plan が「missing+cleanup」等を再生成し、apply が空 Operation を無限に
  // 作り続けていた(operator UI 上 endless successful-but-empty)。
  // 「clean 済みだが DB Instance が deleted に落ちきっていない」状態は
  // reason=<class>_clean_pending_db で明示し、Task 12 の cleanup Operation が
  // Instance state を進めた時点で自然に in_sync に収束する。
  // review round 6 #1/#2: hasCleanupWork は「vertical slice の cleanup step が
  // 実際に消せるもの」= Cloudflare 側の binding + observation のみを見る。
  // 全 binding(Proxmox VM binding 含む)を数えると、CF cleanup 後も VM binding
  // が残るせいで hasCleanupWork=true が固定化し、apply が空 Operation を
  // 作り続けていた(Task 12 が Instance/VM を撤収するまで解消しない)。
  const hasCleanupWork =
    cfBindingIds.length > 0 ||
    observation.cloudflareRouteCount > 0 ||
    observation.cloudflareIngressCount > 0 ||
    observation.cloudflareAppCount > 0

  if (desired === undefined) {
    // unmanaged: 命名 filter を通ってきた観測は必ずここに来る。
    // adopted であっても hasCleanupWork=false(観測 0 件)なら消すべき resource が
    // 無いので noop に落とす(unmanaged と分類し続けると次 plan で復活する)。
    if (!hasCleanupWork) {
      return { ...base, classification: "in_sync", action: "noop", reason: "unmanaged_clean" }
    }
    return {
      ...base,
      classification: "unmanaged_orphan",
      action: adopted ? "adopt_cleanup" : "blocked",
      reason: adopted ? "adopted_for_cleanup" : "requires_adopt_confirmation"
    }
  }

  // desired 有り。Instance が既に deleted になっているのに binding が残る =
  // 過去 cleanup が途中で止まった managed_orphan。
  const instanceDeleted = Option.match(desired.instanceStatus, {
    onNone: () => false,
    onSome: (status) => status === "deleted"
  })
  if (instanceDeleted) {
    if (!hasCleanupWork) {
      // 全 binding 削除済み + CF resource 無し = 実質 clean。Instance が deleted
      // で座っている以外に何もない状態を noop で返して apply ループを止める。
      return {
        ...base,
        classification: "in_sync",
        action: "noop",
        reason: "managed_orphan_clean"
      }
    }
    return {
      ...base,
      classification: "managed_orphan",
      action: "cleanup",
      reason: "instance_deleted_bindings_remain"
    }
  }

  if (!proxmoxVmObserved) {
    if (!hasCleanupWork) {
      // VM が消え、CF resource も binding も落ちきった状態。Instance を deleted
      // へ進めるのは Task 12 の役目。ここは apply ループを止めるため noop。
      return {
        ...base,
        classification: "missing",
        action: "noop",
        reason: "missing_clean_pending_db"
      }
    }
    return {
      ...base,
      classification: "missing",
      action: "cleanup",
      reason: "vm_missing"
    }
  }

  if (
    observation.cloudflareRouteCount === 0 ||
    observation.cloudflareIngressCount === 0 ||
    observation.cloudflareAppCount === 0
  ) {
    // review round 4 #1 → 7 #1: DNS / ingress / Access のいずれか 1 個でも 0 なら
    // drifted。以前は route(DNS) count と app count しか見ず、tunnel ingress を
    // 落とし忘れた「DNS + Access 残存 + ingress 消失」の中間状態が in_sync に
    // 落ちて cleanup 対象から漏れていた。
    // review #1: 部分欠損(片方だけ 0)を drifted として拾う。以前は `&&` で
    // 両方 0 のときしか drift 検出できず、DNS だけ / Access だけ消えたケースが
    // in_sync に落ちて永遠に無視されていた。片方でも欠けたら cleanup で観測を
    // 整合させる(既存 in_sync 判定は「両方 1 以上」= 完全一致のみ)。
    if (!hasCleanupWork) {
      // VM は残っているが CF resource も binding も全て無い = 再 provisioning
      // 待ち。Task 9 の prepare が担当。apply ループを止めるため noop。
      return {
        ...base,
        classification: "drifted",
        action: "noop",
        reason: "drifted_awaiting_reprovision"
      }
    }
    return {
      ...base,
      classification: "drifted",
      action: "cleanup",
      reason: "cloudflare_missing"
    }
  }

  return {
    ...base,
    classification: "in_sync",
    action: "noop",
    reason: "in_sync"
  }
}

// canonical plan digest。entries は (hostname, classification, action) を key に
// sort し、adoptHostnames も sort。JSON.stringify で決定的なバイト列にしてから
// SHA-256 hex にする。contestId と contestRevision も digest 材料に含めるので、
// contest が revision UP した時点で古い plan は自動的に stale になる。
export interface ComputePlanDigestInput {
  readonly contestId: ContestId
  readonly contestRevision: number
  readonly entries: ReadonlyArray<ReconciliationEntry>
  readonly adoptHostnames: ReadonlyArray<string>
}

export const computePlanDigest = (input: ComputePlanDigestInput): string => {
  const canonicalEntries = input.entries
    .map((e) => ({
      hostname: e.hostname,
      classification: e.classification,
      action: e.action,
      // observation counts は digest に含める(inventory 差分の検出用)。
      proxmoxVmObserved: e.proxmoxVmObserved,
      cloudflareRouteCount: e.cloudflareRouteCount,
      cloudflareIngressCount: e.cloudflareIngressCount,
      cloudflareAppCount: e.cloudflareAppCount
    }))
    .slice()
    .sort((a, b) => {
      if (a.hostname !== b.hostname) return a.hostname < b.hostname ? -1 : 1
      if (a.classification !== b.classification)
        return a.classification < b.classification ? -1 : 1
      return a.action < b.action ? -1 : a.action > b.action ? 1 : 0
    })
  const canonicalAdopt = input.adoptHostnames.slice().sort()
  const canonical = JSON.stringify({
    contestId: input.contestId,
    contestRevision: input.contestRevision,
    adoptHostnames: canonicalAdopt,
    entries: canonicalEntries
  })
  return createHash("sha256").update(canonical).digest("hex")
}

// hostname stem を CF の FQDN やその他の文字列から取り出すヘルパ。
// FQDN "inucon-team1-1.kisen.one" → "inucon-team1-1"
// 既に stem の場合は不変。マッチしなければ null(呼び出し元は filter する)。
// review #4: infra 層(cloudflare / proxmox)からも同じ regex を参照するため
// 単一の source-of-truth として export する。以前は 3 ファイルに同じ literal を
// 抱えており、命名規則変更時に片側だけ更新される事故のリスクがあった。
export const MANAGED_HOSTNAME_PATTERN = /^inucon-team\d+-\d+$/
export const stemOfHostname = (raw: string): string | null => {
  const head = raw.split(".")[0]
  return MANAGED_HOSTNAME_PATTERN.test(head) ? head : null
}

// wire schema(shared/schemas.ts 側の Schema と構造的に一致)。application 層は
// この struct をそのまま HTTP response に返せる。
export const ReconciliationClass = Schema.Literal(...RECONCILIATION_CLASSES)
export const ReconciliationAction = Schema.Literal(...RECONCILIATION_ACTIONS)
