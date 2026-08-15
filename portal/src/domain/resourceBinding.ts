import { Option, Schema } from "effect"
import { ContestId, InstanceId, ResourceBindingId, TeamId } from "./ids.js"

// Task 6: ResourceBinding は「ポータルが所有・管理している外部リソース」の
// 単一 source of truth。reconciliation / cleanup で drift 判定と自動削除
// (owned only)の根拠になる。binding のない legacy resource は adopt 確認を
// 必要とする(cleanup 時に unmanaged_orphan として分類される)。
//
// - provider: "cloudflare" / "proxmox" / "runner" / "backup" 等の外部プロバイダ
// - resourceType: provider 内でユニークな種別("dns_record" / "vm" / ...)
// - canonicalKey: 3-tuple (provider, resourceType, canonicalKey) で unique。
//   hostname など operator が読める形。emails などの機密は含めない。
// - desiredState: "present" / "absent" 等の期待状態。plan 生成で決まる。
// - externalId: 実プロバイダの ID(Cloudflare の DNS record ID など)。
export const ResourcePROVIDERS = ["cloudflare", "proxmox", "runner", "backup"] as const
export type ResourceProvider = (typeof ResourcePROVIDERS)[number]

export const RESOURCE_TYPES = [
  "dns_record",
  "tunnel_ingress",
  "access_application",
  "access_policy",
  "vm",
  "runner_agent",
  "backup_artifact"
] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

export class ResourceBinding extends Schema.Class<ResourceBinding>("ResourceBinding")({
  id: ResourceBindingId,
  contestId: ContestId,
  teamId: Schema.OptionFromNullOr(TeamId),
  instanceId: Schema.OptionFromNullOr(InstanceId),
  provider: Schema.Literal(...ResourcePROVIDERS),
  resourceType: Schema.Literal(...RESOURCE_TYPES),
  canonicalKey: Schema.String,
  externalId: Schema.OptionFromNullOr(Schema.String),
  desiredState: Schema.String,
  lastObservedState: Schema.OptionFromNullOr(Schema.String),
  lastObservedAt: Schema.OptionFromNullOr(Schema.Int)
}) {}

// factory: 新規 binding。plan_apply で生成される。
export const newResourceBinding = (args: {
  readonly id: ResourceBindingId
  readonly contestId: ContestId
  readonly teamId?: TeamId
  readonly instanceId?: InstanceId
  readonly provider: ResourceProvider
  readonly resourceType: ResourceType
  readonly canonicalKey: string
  readonly externalId?: string
  readonly desiredState: string
}): ResourceBinding =>
  new ResourceBinding({
    id: args.id,
    contestId: args.contestId,
    teamId: args.teamId === undefined ? Option.none() : Option.some(args.teamId),
    instanceId: args.instanceId === undefined ? Option.none() : Option.some(args.instanceId),
    provider: args.provider,
    resourceType: args.resourceType,
    canonicalKey: args.canonicalKey,
    externalId: args.externalId === undefined ? Option.none() : Option.some(args.externalId),
    desiredState: args.desiredState,
    lastObservedState: Option.none(),
    lastObservedAt: Option.none()
  })
