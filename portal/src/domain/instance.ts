import { Either, Option, Schema } from "effect"
import { InstanceId, TeamId } from "./ids.js"
import { InvalidInstanceTransition } from "./errors.js"

export type InstanceStatus = "creating" | "running" | "deleting" | "deleted" | "failed"

// saga(払い出し/撤収)の進行ステップ記録。addStep で1つずつ積む。
export type ProvisionStep = "clone_done" | "configured" | "started" | "route_done" | "access_done"

export class Instance extends Schema.Class<Instance>("Instance")({
  id: InstanceId,
  teamId: TeamId,
  index: Schema.Int.pipe(Schema.positive()),
  vmid: Schema.Int,
  privateIp: Schema.String,
  status: Schema.Literal("creating", "running", "deleting", "deleted", "failed"),
  progress: Schema.Array(Schema.Literal("clone_done", "configured", "started", "route_done", "access_done")),
  errorMessage: Schema.OptionFromNullOr(Schema.String),
  createdAt: Schema.Int,
  updatedAt: Schema.Int
}) {}

// vmid の通常規則(スペック §Instance 集約 不変条件3): 1000 + teamNumber*100 + index。
// 払い出し(saga)ではこの式で vmid を決めるが、admin の台帳取り込み
// (POST /api/instances)は式に従わない実 VM の vmid を明示指定できる(既定値扱い)。
// (実績: team1-1 = 1101)。IP は既存規則 10.100.<teamNumber>.1<index>。
export const vmidFor = (teamNumber: number, index: number): number => 1000 + teamNumber * 100 + index

export const ipFor = (teamNumber: number, index: number): string => `10.100.${teamNumber}.1${index}`

// 追加ボタン(ガード通過後)の INSERT に対応する初期状態。creating で
// progress は空から始まる。
export const newInstance = (args: {
  id: InstanceId
  teamId: TeamId
  index: number
  teamNumber: number
  now: number
}): Instance =>
  new Instance({
    id: args.id,
    teamId: args.teamId,
    index: args.index,
    vmid: vmidFor(args.teamNumber, args.index),
    privateIp: ipFor(args.teamNumber, args.index),
    status: "creating",
    progress: [],
    errorMessage: Option.none(),
    createdAt: args.now,
    updatedAt: args.now
  })

// creating → running(払い出し完了)。
export const markProvisioned = (i: Instance, now: number): Either.Either<Instance, InvalidInstanceTransition> =>
  i.status === "creating"
    ? Either.right(new Instance({ ...i, status: "running", updatedAt: now }))
    : Either.left(new InvalidInstanceTransition({ instanceId: i.id, from: i.status, to: "running" }))

// running/failed → deleting(削除ボタン、または failed の残骸掃除のための再削除)。
export const beginDeleting = (i: Instance, now: number): Either.Either<Instance, InvalidInstanceTransition> =>
  i.status === "running" || i.status === "failed"
    ? Either.right(new Instance({ ...i, status: "deleting", updatedAt: now }))
    : Either.left(new InvalidInstanceTransition({ instanceId: i.id, from: i.status, to: "deleting" }))

// deleting → deleted(撤収完了)。
export const markDeleted = (i: Instance, now: number): Either.Either<Instance, InvalidInstanceTransition> =>
  i.status === "deleting"
    ? Either.right(new Instance({ ...i, status: "deleted", updatedAt: now }))
    : Either.left(new InvalidInstanceTransition({ instanceId: i.id, from: i.status, to: "deleted" }))

// 任意状態 → failed(状態ガード無し)。失敗の記録は常に受理する。想定される
// 呼び出しは creating の途中失敗・deleting の撤収失敗だが、型シグネチャは Either を
// 返さず、正しい状態からのみ呼ぶ責任は呼び出し元(ワーカーの補償フロー)にある。
export const markFailed = (i: Instance, message: string, now: number): Instance =>
  new Instance({ ...i, status: "failed", errorMessage: Option.some(message), updatedAt: now })

// progress へ 1 ステップ追加する(冪等: 既に記録済みなら何もしない)。
export const addStep = (i: Instance, step: ProvisionStep, now: number): Instance =>
  i.progress.includes(step)
    ? i
    : new Instance({ ...i, progress: [...i.progress, step], updatedAt: now })
