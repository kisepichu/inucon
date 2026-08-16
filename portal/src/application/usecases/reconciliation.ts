import { Clock, Effect, Option } from "effect"
import type { ContestId, ResourceBindingId, UserId } from "../../domain/ids.js"
import type { Instance } from "../../domain/instance.js"
import { ResourceBinding } from "../../domain/resourceBinding.js"
import type { Team } from "../../domain/team.js"
import {
  classifyHostname,
  computePlanDigest,
  stemOfHostname
} from "../../domain/reconciliation.js"
import type {
  HostnameDesired,
  HostnameObservation,
  ReconciliationEntry,
  ReconciliationPlan
} from "../../domain/reconciliation.js"
import type { Operation, OperationStep } from "../../domain/operation.js"
import {
  AmbiguousReconciliation,
  ContestNotFound,
  NothingToReconcile,
  StaleReconciliationPlan
} from "../errors.js"
import {
  CloudflareError,
  CloudflarePort,
  ContestRepo,
  HostnameConfig,
  InstanceRepo,
  OperationExecutionError,
  OperationInProgress,
  OperationRepo,
  ProxmoxError,
  ProxmoxPort,
  RepoError,
  ResourceBindingRepo,
  TeamRepo,
  UuidGen
} from "../ports.js"
import type { OperationHandler } from "../ports.js"
import type { StepOutcome } from "./operations.js"

// Task 7 §Reconciliation の vertical slice。plan/apply の骨格を実装する。
//
// plan: contest scope の binding + instance + team を DB から、また provider
// inventory を Proxmox/Cloudflare から取得し、hostname (stem = `inucon-teamN-M`)
// 単位に畳んで domain.classifyHostname に渡す。結果を canonical sort + SHA-256
// digest で封印して返す。
//
// apply: リクエストの (planDigest, adoptHostnames) を受け、
// もう一度 inventory + DB を読んで再計算した digest / revision と突き合わせる。
// - digest 不一致            → StaleReconciliationPlan (409)
// - blocked entry あり       → AmbiguousReconciliation (422、hostnames を返す)
// パスすれば OperationRepo.enqueue で `reconcile` Operation を投入する。
// 各 step は Task 7 Step 5 の handler が実行時に再度観測 + 冪等な mutation を行う。

export interface ReconciliationApplyInput {
  readonly contestId: ContestId
  readonly planDigest: string
  // review round 8 #2: contestRevision は削除。planDigest が
  // contestRevision を digest 材料に含むため楽観ロックとして冗長だった。
  readonly adoptHostnames: ReadonlyArray<string>
  readonly actorUserId: UserId
}

export interface ReconciliationPlanInput {
  readonly contestId: ContestId
  readonly adoptHostnames: ReadonlyArray<string>
}

// contest scope の DB desired state を hostname (stem) に畳む。
// 現行 provisioning では 1 Instance あたり VM/DNS/ingress/App の 4 種 binding
// を張ることを Task 6/9 で規定しており、canonicalKey には hostname stem を
// 揃える契約(binding.canonicalKey = `inucon-teamN-M`)。
const buildDesiredByHostname = (
  teams: ReadonlyArray<Team>,
  instances: ReadonlyArray<Instance>,
  bindings: ReadonlyArray<ResourceBinding>,
  contestId: ContestId
): Map<string, HostnameDesired> => {
  const teamById = new Map(teams.map((t) => [t.id, t] as const))
  const byHostname = new Map<string, HostnameDesired>()

  const upsert = (
    hostname: string,
    patch: (existing: HostnameDesired | undefined) => HostnameDesired
  ) => {
    byHostname.set(hostname, patch(byHostname.get(hostname)))
  }

  for (const instance of instances) {
    const team = teamById.get(instance.teamId)
    if (team === undefined) continue
    const hostname = `inucon-team${team.teamNumber}-${instance.index}`
    upsert(hostname, () => ({
      hostname,
      contestId,
      teamId: Option.some(team.id),
      instanceId: Option.some(instance.id),
      instanceStatus: Option.some(instance.status),
      cloudflareBindingIds: [],
      proxmoxBindingIds: []
    }))
  }
  for (const binding of bindings) {
    const hostname = binding.canonicalKey
    upsert(hostname, (existing) => {
      const base: HostnameDesired = existing ?? {
        hostname,
        contestId,
        teamId: binding.teamId,
        instanceId: binding.instanceId,
        instanceStatus: Option.none(),
        cloudflareBindingIds: [],
        proxmoxBindingIds: []
      }
      if (binding.provider === "cloudflare") {
        return { ...base, cloudflareBindingIds: [...base.cloudflareBindingIds, binding.id] }
      }
      if (binding.provider === "proxmox") {
        return { ...base, proxmoxBindingIds: [...base.proxmoxBindingIds, binding.id] }
      }
      // runner / backup provider は現行 vertical slice の対象外だが、将来の
      // 拡張で hostname-scoped になったら追加分岐を足す。今は無視する
      // (bindingIds に含めない = classifier 側でも見えない)。
      return base
    })
  }

  return byHostname
}

// Proxmox VM 一覧と CF inventory を hostname stem に畳む。
// hostname stem は既に filter 済みの前提(port 側で `^inucon-team\d+-\d+$`
// にマッチしないものは返さない契約)だが、防御的にここでも stem を通す。
const buildObservationByHostname = (args: {
  readonly proxmoxVms: ReadonlyArray<{ vmid: number; name: string; status: "running" | "stopped" }>
  readonly routes: ReadonlyArray<{ hostname: string; dnsRecordIds: ReadonlyArray<string>; ingressServices: ReadonlyArray<string> }>
  readonly apps: ReadonlyArray<{ hostname: string; appIds: ReadonlyArray<string>; policyShape: "owned_exact" | "unknown"; emailSetHash: string }>
}): Map<string, HostnameObservation> => {
  const map = new Map<string, HostnameObservation>()
  const ensure = (hostname: string): HostnameObservation => {
    const existing = map.get(hostname)
    if (existing !== undefined) return existing
    const created: HostnameObservation = {
      hostname,
      proxmoxVm: Option.none(),
      cloudflareRouteCount: 0,
      cloudflareIngressCount: 0,
      cloudflareAppCount: 0
    }
    map.set(hostname, created)
    return created
  }

  for (const vm of args.proxmoxVms) {
    const stem = stemOfHostname(vm.name)
    if (stem === null) continue
    map.set(stem, {
      ...ensure(stem),
      proxmoxVm: Option.some({ vmid: vm.vmid, status: vm.status })
    })
  }
  for (const route of args.routes) {
    const stem = stemOfHostname(route.hostname)
    if (stem === null) continue
    const cur = ensure(stem)
    // 各 hostname に付く DNS record は 1 個が正常。>1 は ambiguous 検出用に
    // dnsRecordIds の長さで表現する(ingress ではなく DNS を数える)。
    // review round 7 #1: ingress の欠損(DNS 残存 + ingress 消失)を drifted
    // として拾うため、ingressServices.length を独立に保持する。
    map.set(stem, {
      ...cur,
      cloudflareRouteCount: route.dnsRecordIds.length,
      cloudflareIngressCount: route.ingressServices.length
    })
  }
  for (const app of args.apps) {
    const stem = stemOfHostname(app.hostname)
    if (stem === null) continue
    const cur = ensure(stem)
    map.set(stem, { ...cur, cloudflareAppCount: app.appIds.length })
  }

  return map
}

const collectPlan = (args: {
  readonly contestId: ContestId
  readonly contestRevision: number
  readonly generatedAt: number
  readonly adoptHostnames: ReadonlyArray<string>
  readonly desired: ReadonlyMap<string, HostnameDesired>
  readonly observation: ReadonlyMap<string, HostnameObservation>
}): ReconciliationPlan => {
  const adoptSet = new Set(args.adoptHostnames)
  const hostnames = new Set<string>()
  for (const key of args.desired.keys()) hostnames.add(key)
  for (const key of args.observation.keys()) hostnames.add(key)

  const entries: Array<ReconciliationEntry> = []
  for (const hostname of hostnames) {
    const observation = args.observation.get(hostname) ?? {
      hostname,
      proxmoxVm: Option.none<{ vmid: number; status: string }>(),
      cloudflareRouteCount: 0,
      cloudflareIngressCount: 0,
      cloudflareAppCount: 0
    }
    const desired = args.desired.get(hostname)
    entries.push(
      classifyHostname({
        observation,
        desired,
        adopted: adoptSet.has(hostname)
      })
    )
  }
  const planDigest = computePlanDigest({
    contestId: args.contestId,
    contestRevision: args.contestRevision,
    entries,
    adoptHostnames: args.adoptHostnames
  })
  return {
    contestId: args.contestId,
    contestRevision: args.contestRevision,
    planDigest,
    generatedAt: args.generatedAt,
    entries,
    adoptHostnames: args.adoptHostnames
  }
}

export type ReconciliationError =
  | RepoError
  | ContestNotFound
  | ProxmoxError
  | CloudflareError

export const planReconciliation = (
  input: ReconciliationPlanInput
): Effect.Effect<
  ReconciliationPlan,
  ReconciliationError,
  ContestRepo | InstanceRepo | ResourceBindingRepo | TeamRepo | ProxmoxPort | CloudflarePort
> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const contestOpt = yield* contests.findById(input.contestId)
    if (Option.isNone(contestOpt)) return yield* Effect.fail(new ContestNotFound())
    const contest = contestOpt.value

    const teamsRepo = yield* TeamRepo
    const teams = yield* teamsRepo.listByContest(input.contestId)
    const instancesRepo = yield* InstanceRepo
    // TeamRepo/InstanceRepo が contest scope なので、team ごとに listByTeam を
    // 呼び集約する(spec のクエリコストは Team 数に比例 = 1 桁で十分)。
    const instancesByTeam = yield* Effect.forEach(teams, (t) => instancesRepo.listByTeam(input.contestId, t.id))
    const instances: ReadonlyArray<Instance> = instancesByTeam.flat()
    const bindings = yield* (yield* ResourceBindingRepo).listByContest(input.contestId)

    // review round 5 #3: Proxmox / Cloudflare の inventory は独立して読めるので
    // 並列化する(以前は直列で latency = P + C だった)。getInstanceInventory は
    // 内部で policies 取得を concurrency 10 で並列化しているので、両方の外側でも
    // 並列にすると plan 全体の latency = max(P, C_bulk) に短縮できる。
    const proxmox = yield* ProxmoxPort
    const cloudflare = yield* CloudflarePort
    const [proxmoxVms, inventory] = yield* Effect.all(
      [proxmox.listManagedVms, cloudflare.getInstanceInventory],
      { concurrency: "unbounded" }
    )

    const now = yield* Clock.currentTimeMillis

    return collectPlan({
      contestId: input.contestId,
      contestRevision: contest.revision,
      generatedAt: now,
      adoptHostnames: input.adoptHostnames,
      desired: buildDesiredByHostname(teams, instances, bindings, input.contestId),
      observation: buildObservationByHostname({
        proxmoxVms,
        routes: inventory.routes,
        apps: inventory.apps
      })
    })
  })

// Task 7 review #3: `plan.contestRevision !== input.contestRevision` の分岐は
// computePlanDigest が contestRevision を含めるため物理的に到達しない
// (planDigest 一致 ⇒ contestRevision 一致)。呼び出し側は planDigest だけを
// 楽観ロックとして扱えばよく、error 型からも ContestRevisionConflict を外す。
export type ReconciliationApplyError =
  | ReconciliationError
  | StaleReconciliationPlan
  | AmbiguousReconciliation
  | NothingToReconcile
  | OperationInProgress

// apply は plan と全く同じ inventory 読み取りをした上で digest を突き合わせる。
// 「Never accept arbitrary resource IDs from the browser」(spec Step 4): 呼び
// 出し元(ブラウザ)は planDigest と adoptHostnames しか渡してこないので、DB /
// provider ID の一切はサーバー側で再構築する。
export const applyReconciliation = (
  input: ReconciliationApplyInput
): Effect.Effect<
  Operation,
  ReconciliationApplyError,
  ContestRepo | InstanceRepo | ResourceBindingRepo | TeamRepo | ProxmoxPort | CloudflarePort | OperationRepo
> =>
  Effect.gen(function* () {
    const plan = yield* planReconciliation({
      contestId: input.contestId,
      adoptHostnames: input.adoptHostnames
    })

    if (plan.planDigest !== input.planDigest) {
      return yield* Effect.fail(new StaleReconciliationPlan())
    }
    // NOTE: contestRevision の突き合わせは planDigest 一致で自動的に担保される
    // (computePlanDigest に contestRevision を含めているため、片方だけ違うのは
    // 到達不能)。冗長な dead check を残さず、error 型からも除外する
    // (Task 7 review #3)。

    const blocked = plan.entries.filter((e) => e.action === "blocked").map((e) => e.hostname)
    if (blocked.length > 0) {
      return yield* Effect.fail(new AmbiguousReconciliation({ hostnames: blocked }))
    }

    // noop の entry は step にせずスキップ。cleanup / adopt_cleanup のみが step。
    const actionable = plan.entries.filter(
      (e) => e.action === "cleanup" || e.action === "adopt_cleanup"
    )

    const operations = yield* OperationRepo
    if (actionable.length === 0) {
      // Task 7 review #2: actionable が 0 件 = 既に clean。0-step Operation を
      // enqueue すると OperationRepo が permanent unfinished lock として die する
      // ため、専用の NothingToReconcile を返す(client は 409 で「既に clean」
      // と区別できる。以前は AmbiguousReconciliation(hostnames=[]) を返して
      // いたが blocked orphan と混同されるためドロップ)。
      return yield* Effect.fail(new NothingToReconcile())
    }

    const steps = actionable
      .slice()
      .sort((a, b) => (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0))
      .map((entry, ordinal) => ({
        stepKey: `reconcile:${entry.hostname}`,
        ordinal,
        // hostname/action/contestId 以外は step 側では読まない(実行時は再観測)。
        // sanitize 済み reason は operator 監査用に summary にだけ残す。
        // review #2: contestId を含めて渡し、adopt_cleanup の ResourceBinding
        // 作成先を step だけで解決できるようにする(operation の再取得不要)。
        inputSummary: JSON.stringify({
          hostname: entry.hostname,
          action: entry.action,
          contestId: input.contestId,
          expectedClass: entry.classification,
          reason: entry.reason
        }),
        continueOnError: false
      }))

    return yield* operations.enqueue({
      contestId: input.contestId,
      kind: "reconcile",
      actor: { kind: "admin", userId: input.actorUserId },
      planDigest: plan.planDigest,
      contestRevision: plan.contestRevision,
      steps
    })
  })

// Task 7 Step 5: reconcile Operation の 1 step (hostname 単位)を実行する。
// worker が step.inputSummary を渡してくれるので、hostname / action を JSON
// decode したうえで:
//   1. inventory を再観測(plan 生成後に別 admin が変えている可能性)。
//   2. hostname 単位で分類し直し、blocked / ambiguous なら retry せず blocked。
//   3. adopt_cleanup なら CF の観測 resource から ResourceBinding を先に張る。
//   4. cleanup: CF DNS + Access app + tunnel ingress を冪等に撤収し、Instance
//      が残っていれば running/failed → deleting → deleted に遷移する。VM 撤収
//      自体は cleanup Operation (Task 12) が扱うため、ここでは触らない。
//   5. 完了後、binding を全削除して provider inventory と DB を同時に空に落とす。
//
// worker のリトライ規則(operationWorker.ts)を維持するため、外部 provider
// 失敗は Effect.fail のまま上に伝える(worker 側が sanitize + backoff する)。
// 「あいまい観測」は "blocked" outcome で明示的に operator 待ちに落とす。

interface StepInput {
  readonly hostname: string
  readonly action: "cleanup" | "adopt_cleanup"
  readonly contestId: string
  readonly expectedClass: string
  readonly reason: string
}

const parseStepInput = (raw: string): StepInput | null => {
  try {
    const parsed = JSON.parse(raw) as StepInput
    if (typeof parsed.hostname !== "string") return null
    if (typeof parsed.contestId !== "string") return null
    if (parsed.action !== "cleanup" && parsed.action !== "adopt_cleanup") return null
    return parsed
  } catch {
    return null
  }
}

// review #2: adopt_cleanup は「observed CF resource から ResourceBinding を張って
// から cleanup と同じ経路」= 削除前に監査行を残す。resourceType ごとに一意な
// (provider, resource_type, canonical_key) は canonicalKey = hostname stem で
// 共有する(upsert が既存を差し替えるので冪等)。

// makeReconciliationHandler: OperationHandlerRegistry へ登録するための
// Effect ファクトリ。Layer.effect の中で yield して deps を解決すれば、
// worker.run へ渡す OperationHandler が context-free で作れる。
export const makeReconciliationHandler: Effect.Effect<
  OperationHandler,
  never,
  CloudflarePort | ResourceBindingRepo | UuidGen | HostnameConfig
> = Effect.gen(function* () {
  const cloudflare = yield* CloudflarePort
  const bindings = yield* ResourceBindingRepo
  const uuid = yield* UuidGen
  const hostnameConfig = yield* HostnameConfig
  const run = (step: OperationStep): Effect.Effect<StepOutcome, OperationExecutionError> =>
    Effect.gen(function* () {
      const parsed = parseStepInput(step.inputSummary)
      if (parsed === null) {
        return { status: "blocked" as const, summary: "invalid_step_input" }
      }
      // review round 3 #2: FQDN 生成は HostnameConfig 経由。zone を切替えたら
      // env だけ書き換えれば全 caller が追従する(hard-code なら silent no-op に
      // なる)。
      const fqdn = `${parsed.hostname}.${hostnameConfig.zoneName}`

      // review round 3 #3: cleanup / adopt_cleanup どちらの action でも、
      // step 実行時点で inventory を再観測して分類を再判定する。以前は
      // adopt_cleanup で binding を upsert してから removeInstanceRoute を
      // 呼んでいたため、plan から step 実行までの間に CF が duplicate を持ち
      // 込む(managed_orphan/ambiguous に遷移)と、binding だけ書き込まれた
      // 中途半端な状態で findDnsRecord が失敗 → step blocked、次 plan の
      // 分類が別物になる race があった。observation が ambiguous(重複)や
      // 完全欠損に遷移していたら、mutation を一切行わず blocked で返して
      // operator 判断に任せる。
      const inventory = yield* cloudflare.getInstanceInventory
      const route = inventory.routes.find((r) => r.hostname === parsed.hostname)
      const app = inventory.apps.find((a) => a.hostname === parsed.hostname)
      const routeDupes = route !== undefined && route.dnsRecordIds.length > 1
      const ingressDupes = route !== undefined && route.ingressServices.length > 1
      const appDupes = app !== undefined && app.appIds.length > 1
      if (routeDupes || ingressDupes || appDupes) {
        return { status: "blocked" as const, summary: "ambiguous_on_reobserve" }
      }

      // review round 2 #2 (継続): adopt_cleanup は teardown 前に、
      // observation で確認できた各 CF resource を portal 所有として
      // ResourceBinding に upsert する。ここまでで observation が
      // non-ambiguous であることを既に確認しているので、書き込み後の
      // 削除が失敗して partial state が残るリスクは大幅に下がる。
      if (parsed.action === "adopt_cleanup") {
        // review round 7 #2: plan → step の間に別 admin が同 hostname に
        // 新 Team/Instance を割り当てて実 binding を張った場合、この step が
        // 上書き(unique key: provider+resource_type+canonical_key)して
        // desiredState=absent の binding を書き、続く removeInstanceRoute で
        // フレッシュに provision された CF resource を破壊する race がある。
        // teamId が Some の binding が既に存在するなら「他 admin が adopt
        // 済み」= mutation を止め blocked で返して operator 判断に任せる。
        const existing = yield* bindings.listByContest(
          parsed.contestId as unknown as ContestId
        )
        const alreadyAdopted = existing.some(
          (b) => b.canonicalKey === parsed.hostname && Option.isSome(b.teamId)
        )
        if (alreadyAdopted) {
          return { status: "blocked" as const, summary: "hostname_adopted_concurrently" }
        }
        const bindingSpecs: ReadonlyArray<{
          readonly resourceType: "dns_record" | "tunnel_ingress" | "access_application"
          readonly externalId: string | undefined
        }> = [
          ...(route !== undefined && route.dnsRecordIds.length > 0
            ? [{ resourceType: "dns_record" as const, externalId: route.dnsRecordIds[0] }]
            : []),
          ...(route !== undefined && route.ingressServices.length > 0
            ? [{ resourceType: "tunnel_ingress" as const, externalId: undefined }]
            : []),
          ...(app !== undefined && app.appIds.length > 0
            ? [{ resourceType: "access_application" as const, externalId: app.appIds[0] }]
            : [])
        ]
        for (const spec of bindingSpecs) {
          const id = yield* uuid.next
          yield* bindings.upsert(
            new ResourceBinding({
              id: id as unknown as ResourceBindingId,
              contestId: parsed.contestId as unknown as ContestId,
              teamId: Option.none(),
              instanceId: Option.none(),
              provider: "cloudflare",
              resourceType: spec.resourceType,
              canonicalKey: parsed.hostname,
              externalId: spec.externalId === undefined ? Option.none() : Option.some(spec.externalId),
              desiredState: "absent",
              lastObservedState: Option.some("present"),
              lastObservedAt: Option.none()
            })
          )
        }
      }

      // 現行 vertical slice の cleanup は CF DNS/ingress/Access を冪等に落とす
      // のみを担う。Instance 状態遷移(deleting → deleted)と VM 撤収は
      // Task 12 の cleanup Operation が引き継ぐ(spec §Reconciliation:
      // 「実体のない running Instance は reconciliation operation の監査記録を
      // 伴って解消する」)。
      yield* cloudflare.removeInstanceRoute(fqdn)
      yield* cloudflare.removeAccessApp(fqdn)

      // review round 4 #1: CF resource を落としたら対応する ResourceBinding も
      // 削除する。以前は upsert したまま放置していたため、次 plan で同 hostname
      // が missing / managed_orphan として再分類され、cleanup ループが永久に
      // 続いていた(NothingToReconcile に到達しない)。contest scope の全 binding
      // から canonicalKey==hostname のものを絞って deleteById。
      const contestBindings = yield* bindings.listByContest(
        parsed.contestId as unknown as ContestId
      )
      for (const binding of contestBindings) {
        if (binding.canonicalKey === parsed.hostname && binding.provider === "cloudflare") {
          yield* bindings.deleteById(binding.id)
        }
      }

      return { status: "succeeded" as const, summary: `reconciled:${parsed.hostname}` }
    }).pipe(Effect.catchAll((cause) => Effect.fail(new OperationExecutionError({ cause }))))

  return { run }
})
