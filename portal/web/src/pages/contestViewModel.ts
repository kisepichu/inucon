// Task 13: ContestAdmin / OperationDetail 用の純粋な view model。
//
// UI から独立させることで:
// - React に依存しない単体テストで検証できる。
// - 「Contest の状態に応じて何のアクションが有効か」「readiness の非機密
//   グルーピング」「unmanaged_orphan の adopt 必須リスト」といった判断が
//   1 箇所に集まり、複数タブが同じルールで振る舞う。
//
// wire schema の全 Option フィールドは事前に null 許容 struct に畳まれている
// (BenchJob/Operation と同じ規約)ため、ここでは null チェックだけで済む。
import type {
  Contest,
  ContestStatus,
  Operation,
  OperationStatus,
  ReadinessCheck,
  ReadinessCheckStatus,
  ReconciliationEntry,
  ReconciliationPlan
} from "shared/schemas"

// ---- Status labels --------------------------------------------------------

// Contest lifecycle 状態 → 日本語ラベル (UI 表示用)。canceled も履歴目的で
// 表示するため含める (Task 1 の 6 状態と 1:1)。
export const contestStatusLabel: Record<ContestStatus, string> = {
  draft: "下書き",
  preparing: "準備中",
  running: "開催中",
  finalizing: "確定処理中",
  finished: "終了",
  canceled: "キャンセル"
}

// Operation status ラベル (badge の状態単語)。domain の 6 状態と 1:1。
export const operationStatusLabel: Record<OperationStatus, string> = {
  queued: "待機中",
  running: "実行中",
  succeeded: "成功",
  failed: "失敗",
  blocked: "対応待ち",
  canceled: "キャンセル"
}

// ---- Action enablement ----------------------------------------------------

// ContestAdmin の各アクションボタンの有効/無効を Contest.status から一元的に
// 決める。UI はここの真偽値を disabled にそのまま流し込む (別の場所で判定を
// 分散させない = readiness やタブ切替に伴う不整合を避ける)。
//
// draft/preparing/running/finalizing/finished/canceled の各状態で:
//  - editDraft:    draft のみ (schedule/quota は preparing 以降は immutable)
//  - beginPrepare: draft のみ (draft → preparing)
//  - enterContestMode: preparing のみ (devvm 停止 → benchvm 起動、spec §3)
//  - prepareInstances: preparing のみ (desired 台数の VM / 経路を準備、spec §4)
//  - rehearsal:    preparing のみ (running の Instance 1 台にベンチ。readiness
//                  `rehearsal` は start の必須項目。backend も preparing 以外は
//                  ContestNotPreparing で拒否する)
//  - startContest: preparing のみ (preparing → running)
//  - immediateFinish: running のみ (running → finalizing、scheduler と同経路)
//  - cancelDraft:  draft or preparing のみ (Task 1 の遷移 fig)
//  - reconcile:    preparing / running / finalizing / finished 全般
//  - cleanup:      finished / canceled のみ (running 中は cleanup を打たない。ボタンは
//                  plan / digest / 対象一覧がある Reconciliation タブに置く)
//  - returnNormal: finished / canceled のみ (cleanup 後に benchvm→devvm)
//  - rearchive:    finished のみ (legacy contest の archive 再生成)
export interface ContestActionEnablement {
  readonly editDraft: boolean
  readonly beginPrepare: boolean
  readonly enterContestMode: boolean
  readonly prepareInstances: boolean
  readonly rehearsal: boolean
  readonly startContest: boolean
  readonly immediateFinish: boolean
  readonly cancelDraft: boolean
  readonly reconcile: boolean
  readonly cleanup: boolean
  readonly returnNormal: boolean
  readonly rearchive: boolean
}

export const computeContestActions = (contest: Contest): ContestActionEnablement => {
  const s = contest.status
  return {
    editDraft: s === "draft",
    beginPrepare: s === "draft",
    enterContestMode: s === "preparing",
    prepareInstances: s === "preparing",
    rehearsal: s === "preparing",
    startContest: s === "preparing",
    immediateFinish: s === "running",
    cancelDraft: s === "draft" || s === "preparing",
    reconcile: s === "preparing" || s === "running" || s === "finalizing" || s === "finished",
    cleanup: s === "finished" || s === "canceled",
    returnNormal: s === "finished" || s === "canceled",
    rearchive: s === "finished"
  }
}

// ---- Readiness grouping ---------------------------------------------------

// Readiness タブ用: status ごとに check をまとめる。順序は fail → warn → pass
// (fail を最初に出して operator が対応順序を判断しやすくする)。生 email /
// cause は readiness の contract で summary に含まれない前提だが、UI 側でも
// summary を素通ししているだけであることを明示するため型を通す。
export interface GroupedReadiness {
  readonly fail: ReadonlyArray<ReadinessCheck>
  readonly warn: ReadonlyArray<ReadinessCheck>
  readonly pass: ReadonlyArray<ReadinessCheck>
}

export const groupReadinessByStatus = (checks: ReadonlyArray<ReadinessCheck>): GroupedReadiness => {
  const buckets: Record<ReadinessCheckStatus, Array<ReadinessCheck>> = { pass: [], warn: [], fail: [] }
  for (const c of checks) buckets[c.status].push(c)
  return { fail: buckets.fail, warn: buckets.warn, pass: buckets.pass }
}

// Readiness が blocking (fail が 1 件以上) かどうかを bool で返す。start の
// dangerous-action ボタンで「readiness が通っていないなら押させない」判断に使う。
export const hasBlockingReadinessFailure = (checks: ReadonlyArray<ReadinessCheck>): boolean =>
  checks.some((c) => c.status === "fail")

// ---- Reconciliation classification ----------------------------------------

// unmanaged_orphan は adopt をしないと apply が 422 AmbiguousReconciliation に
// 落ちるので、UI は該当 hostname を明示チェックさせる必要がある (Task 7 spec)。
// ここで hostname 集合を切り出して ContestAdmin の Reconciliation タブに渡す。
export const adoptRequiredHostnames = (plan: ReconciliationPlan): ReadonlyArray<string> =>
  plan.entries.filter((e) => e.classification === "unmanaged_orphan").map((e) => e.hostname)

// 実際に apply したときに mutation が発生する entry (noop 以外)。UI は
// 「今 apply したら何件変更されるか」の要約を出す。
export const actionableEntries = (
  plan: ReconciliationPlan
): ReadonlyArray<ReconciliationEntry> => plan.entries.filter((e) => e.action !== "noop")

// cleanup Operation が step を作る entry。対象選択は server の
// needsCleanupOperation が cleanupTarget として返すので、ここで述語を再実装しない
// (対象選択が 2 箇所にあったことが PR #77 のデッドロックの原因)。
export const cleanupTargetEntries = (
  plan: ReconciliationPlan
): ReadonlyArray<ReconciliationEntry> => plan.entries.filter((e) => e.cleanupTarget)

// server の cleanup / apply は blocked entry が 1 件でもあると
// AmbiguousReconciliation で止まる。押せない理由を UI が先に示すために使う。
export const blockedHostnames = (plan: ReconciliationPlan): ReadonlyArray<string> =>
  plan.entries.filter((e) => e.action === "blocked").map((e) => e.hostname)

// ---- Operation polling ----------------------------------------------------

// terminal status に落ちたら polling を止める。canceled も含む (domain の
// isOperationUnfinished と同意味)。
const TERMINAL: ReadonlyArray<OperationStatus> = ["succeeded", "failed", "canceled"]
export const isOperationTerminal = (status: OperationStatus): boolean => TERMINAL.includes(status)

// operation の代表色分けキー: 対応待ち (blocked) は UI 上「実行中」でも
// 「完了」でもない中間で、operator が retry / cancel を判断する必要がある。
export const operationStatusVariant = (status: OperationStatus): "pending" | "running" | "success" | "error" | "blocked" => {
  if (status === "queued") return "pending"
  if (status === "running") return "running"
  if (status === "succeeded") return "success"
  if (status === "blocked") return "blocked"
  return "error"
}

// ---- Error tag → 日本語 ---------------------------------------------------

// API のエラー _tag → 画面表示用の日本語メッセージ。ContestAdmin と
// OperationDetail が同じマップを共有する。未知の tag はそのまま渡して
// UI が最低限見えるようにする (完全マップは admin 学習コストを上げるだけ)。
// review round 1 spec: typed409 stale response は「状態が変わりました。再診断してください」に、
// typed422 ambiguous / readiness は失敗 key を透過的に表示する。
export const ERROR_MESSAGES: Record<string, string> = {
  Forbidden: "権限がありません",
  NotFound: "対象が見つかりません",
  ContestNotRunning: "コンテストは開催されていません",
  ContestNotPreparing: "コンテストは準備中ではありません",
  ContestRevisionConflict: "状態が変わりました。再診断してください",
  StaleReconciliationPlan: "状態が変わりました。再診断してください",
  OperationalContestConflict: "別の Operation が実行中です",
  InvalidContestTransition: "この状態遷移はできません",
  InvalidContestSchedule: "スケジュールが不正です",
  ContestNotReadyForPreparation: "準備前チェックに失敗しました",
  AmbiguousReconciliation: "unmanaged_orphan を adopt してください",
  NothingToReconcile: "変更対象がありません",
  ProviderUnavailable: "外部プロバイダが一時的に利用できません",
  ResidualManagedResource: "先に cleanup を完了させてください",
  ContestModeNotActive: "競技モードではありません。先に競技モード切替を完了させてください",
  ArtifactChecksumMismatch: "SHA-256 が一致しません",
  InvalidArchiveState: "この状態では archive を再生成できません",
  RehearsalInstanceNotRunning: "対象 Instance が running ではありません。ページを再読み込みして Instance の状態を確認してください",
  TeamJobAlreadyQueued:
    "このチームには既に queued / running の rehearsal job があります。終わる (finished / failed になる) のを待ってから再実行してください",
  InstanceNotFound: "対象 Instance が見つかりません (この開催回のものではないか、削除済みです)",
  TargetIpOutOfSubnet: "Instance の IP がチームのサブネット外です"
}

export const messageForErrorTag = (tag: string): string => ERROR_MESSAGES[tag] ?? tag

// ---- Contest sorting ------------------------------------------------------

// live edition の最大 + 1 (canceled は edition を焼かない、Task 1 の
// partial unique 制約)。Contests 一覧の "新規作成" 遷移で使う。
export const nextLiveEdition = (contests: ReadonlyArray<Contest>): number => {
  const live = contests.filter((c) => c.status !== "canceled").map((c) => c.edition)
  return live.length === 0 ? 1 : Math.max(...live) + 1
}

// 最新の operational Contest を返す (preparing / running / finalizing のうち 1 件)。
// ContestAdmin のリンクと "現在の開催回" 表示に使う。
const OPERATIONAL_STATUSES: Partial<Record<ContestStatus, true>> = { preparing: true, running: true, finalizing: true }
export const operationalContest = (contests: ReadonlyArray<Contest>): Contest | null =>
  contests.find((c) => OPERATIONAL_STATUSES[c.status] === true) ?? null


// ---- Operation display ----------------------------------------------------

// Operation の kind → 日本語ラベル。ContestAdmin / OperationDetail の見出し
// で使う。domain の 9 kind (Task 6-12) と 1:1。
export const operationKindLabel: Record<Operation["kind"], string> = {
  reconcile: "リソース収束",
  enter_contest_mode: "コンテストモード切替",
  prepare: "準備 (Instance 配備)",
  start: "開催開始",
  finish: "確定処理",
  revoke_access: "Access 閉鎖",
  cleanup: "リソース撤収",
  return_normal_mode: "通常モード復帰",
  backup: "スナップショット"
}
