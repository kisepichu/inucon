import { Clock, Effect, Either, Option } from "effect"
import { addStep, markDeleted, markFailed, markProvisioned } from "../../domain/instance.js"
import type { Instance, ProvisionStep } from "../../domain/instance.js"
import type { TeamId } from "../../domain/ids.js"
import {
  CloudflareError,
  CloudflarePort,
  GithubKeysError,
  GithubKeysPort,
  InstanceRepo,
  ProvisioningConfig,
  ProxmoxError,
  ProxmoxPort,
  RepoError,
  TeamRepo
} from "../ports.js"

// tpl-private-isu(スペック §前提: Phase 1 で構築済みのテンプレート VM)。
// VM スペックは固定(2vCPU/4GB/20GB、ユーザー入力を受けない)なので単一の
// テンプレートで足りる(スペック §Instance 集約 不変条件5)。
const TEMPLATE_VMID = 9100

// チームごとの VNet bridge / ゲートウェイ(Terraform 実績と同じ命名規則、
// spike メモ §結論)。ipFor(teamNumber, index) = 10.100.<teamNumber>.1<index>
// と同じ第3オクテットを使うゲートウェイ(<teamNumber>.1)。
const bridgeFor = (teamNumber: number): string => `team${teamNumber}`
const gatewayFor = (teamNumber: number): string => `10.100.${teamNumber}.1`

// スペック §セキュリティ: ホスト名は既存規則 inucon-team{N}-{M}.kisen.one を踏襲。
const hostnameFor = (teamNumber: number, index: number): string => `inucon-team${teamNumber}-${index}.kisen.one`

const describeError = (e: unknown): string => {
  if (typeof e === "object" && e !== null && "_tag" in e) {
    try {
      return JSON.stringify(e)
    } catch {
      return String(e)
    }
  }
  return String(e)
}

// 招待メンバーのメール/鍵集約(スペック §招待フロー「インスタンス新規作成時は
// その時点のチームメンバー+招待中のメール/鍵で構成する」)。Task 5 の
// invites.ts と共有する共通関数になる想定だが、Task 4 では team_invites
// (未ログインユーザーの事前招待)テーブルがまだユースケース経路から
// 参照されていないため、「チームの現メンバー」から集める最小実装にする
// (Task 5 が team_invites を合流させて精緻化する)。
//
// - 鍵は GithubKeysPort.fetchKeys(githubLogin)。未登録(GithubKeysError)の
//   メンバーは黒魔術的にサガ全体を失敗させず、鍵無しとしてスキップする
//   (スペック §招待フロー「email 未登録メンバーの扱い」と同じ「部分的な
//   欠落を許容しつつ処理は続行する」方針を鍵にも適用)。
// - メールは users.email(Option)。未設定(None)のメンバーはスキップする。
export const collectTeamAccess = (
  teamId: TeamId
): Effect.Effect<
  { emails: ReadonlyArray<string>; sshKeys: ReadonlyArray<string> },
  RepoError,
  TeamRepo | GithubKeysPort
> =>
  Effect.gen(function* () {
    const teams = yield* TeamRepo
    const githubKeys = yield* GithubKeysPort
    const members = yield* teams.listMembers(teamId)

    const emails = members.flatMap((m) =>
      Option.match(m.email, { onNone: () => [] as ReadonlyArray<string>, onSome: (e) => [e] })
    )

    const keysPerMember = yield* Effect.forEach(members, (m) =>
      githubKeys.fetchKeys(m.githubLogin).pipe(
        Effect.catchTag("GithubKeysError", () => Effect.succeed([] as ReadonlyArray<string>))
      )
    )

    return { emails, sshKeys: keysPerMember.flat() }
  })

// 払い出し saga(スペック §アーキテクチャ「オーケストレーションの実行・補償
// saga」)。instance.progress を見て未完ステップから再開する(プロセス再起動
// で孤児にしない設計の核)。各ステップ成功後に addStep で progress を DB に
// 保存してから次のステップへ進む。途中失敗時は compensate で progress の
// 逆順に「作った経路/VM」を消し、markFailed で終える(この Effect 自体は
// E=never — ワーカーの常駐ループを止めないため、失敗はすべて内部で
// markFailed に畳み込んで返す)。
export const runProvisioning = (
  initial: Instance
): Effect.Effect<Instance, never, InstanceRepo | ProxmoxPort | CloudflarePort | GithubKeysPort | TeamRepo | ProvisioningConfig> =>
  Effect.gen(function* () {
    const repo = yield* InstanceRepo
    const teams = yield* TeamRepo
    const proxmox = yield* ProxmoxPort
    const cloudflare = yield* CloudflarePort
    const config = yield* ProvisioningConfig

    // team 読み出しの失敗は saga の補償対象ではなく infra 障害(DB)なので
    // defect(die)にする。ワーカーの catchAllCause が握って fiber を殺さず、
    // instance は creating のまま次 tick で再試行される(BenchJob 側の
    // 「ジョブ行が無ければ die」と同じ、状態を DB に残したままの retryable
    // な畳み方)。
    const team = yield* teams.findById(initial.teamId).pipe(
      Effect.orDie,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.dieMessage(`runProvisioning: team ${initial.teamId} not found`),
          onSome: Effect.succeed
        })
      )
    )
    const hostname = hostnameFor(team.teamNumber, initial.index)

    const persistStep = (instance: Instance, step: ProvisionStep) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const updated = addStep(instance, step, now)
        yield* repo.update(updated)
        return updated
      })

    // 逆順の補償: access_done → route_done → (clone_done/configured/started
    // のいずれかがあれば VM 破棄。VM に関する 3 ステップはどれも「VM が
    // Proxmox 上に存在する」ことを意味するので stopAndDestroyVm 1 回で足りる
    // (冪等な port なので複数回呼んでも安全)。Cloudflare 系の失敗は
    // ログに残して次のステップへ進む(1 つの補償失敗で残りの補償を諦めない、
    // TimeoutSweeper と同じ生存性優先の考え方)。
    const compensate = (instance: Instance) =>
      Effect.gen(function* () {
        if (instance.progress.includes("access_done")) {
          yield* cloudflare
            .removeAccessApp(hostname)
            .pipe(Effect.catchAll((e) => Effect.logError(`compensate removeAccessApp failed: ${describeError(e)}`)))
        }
        if (instance.progress.includes("route_done")) {
          yield* cloudflare
            .removeInstanceRoute(hostname)
            .pipe(
              Effect.catchAll((e) => Effect.logError(`compensate removeInstanceRoute failed: ${describeError(e)}`))
            )
        }
        if (instance.progress.some((p) => p === "clone_done" || p === "configured" || p === "started")) {
          yield* proxmox
            .stopAndDestroyVm(instance.vmid)
            .pipe(Effect.catchAll((e) => Effect.logError(`compensate stopAndDestroyVm failed: ${describeError(e)}`)))
        }
      })

    const advance = Effect.gen(function* () {
      let instance = initial

      if (!instance.progress.includes("clone_done")) {
        yield* proxmox.cloneVm({
          templateVmid: TEMPLATE_VMID,
          newVmid: instance.vmid,
          name: `inucon-team${team.teamNumber}-${instance.index}`
        })
        instance = yield* persistStep(instance, "clone_done")
      }

      if (!instance.progress.includes("configured")) {
        const access = yield* collectTeamAccess(instance.teamId)
        yield* proxmox.setVnet({ vmid: instance.vmid, bridge: bridgeFor(team.teamNumber) })
        yield* proxmox.configureCloudInit({
          vmid: instance.vmid,
          ip: instance.privateIp,
          gateway: gatewayFor(team.teamNumber),
          sshKeys: access.sshKeys.join("\n")
        })
        instance = yield* persistStep(instance, "configured")
      }

      if (!instance.progress.includes("started")) {
        yield* proxmox.startVm(instance.vmid)
        yield* proxmox.waitForGuestAgent(instance.vmid, config.guestAgentTimeoutMillis)
        instance = yield* persistStep(instance, "started")
      }

      if (!instance.progress.includes("route_done")) {
        yield* cloudflare.ensureInstanceRoute({ hostname, ip: instance.privateIp })
        instance = yield* persistStep(instance, "route_done")
      }

      if (!instance.progress.includes("access_done")) {
        const access = yield* collectTeamAccess(instance.teamId)
        yield* cloudflare.ensureAccessApp({ hostname, emails: access.emails })
        instance = yield* persistStep(instance, "access_done")
      }

      return instance
    })

    return yield* advance.pipe(
      Effect.matchEffect({
        onSuccess: (instance) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const provisioned = Either.getOrThrow(markProvisioned(instance, now))
            yield* repo
              .update(provisioned)
              .pipe(Effect.catchAll((e) => Effect.logError(`persist provisioned failed: ${describeError(e)}`)))
            return provisioned
          }),
        onFailure: (error) =>
          Effect.gen(function* () {
            // progress は各ステップ成功時に DB へ即時保存済みなので、失敗
            // 直前までの最新状態を repo から読み直す(advance 内のローカル
            // 変数は失敗時に外へ持ち出せないため)。読み直し自体が失敗しても
            // initial にフォールバックする(生存性優先)。
            const current = yield* repo.findById(initial.id).pipe(
              Effect.map(Option.getOrElse(() => initial)),
              Effect.catchAll(() => Effect.succeed(initial))
            )
            yield* compensate(current)
            const now = yield* Clock.currentTimeMillis
            const failed = markFailed(current, describeError(error), now)
            yield* repo
              .update(failed)
              .pipe(Effect.catchAll((e) => Effect.logError(`persist failed-state failed: ${describeError(e)}`)))
            return failed
          })
      })
    )
  })

// 撤収 saga(スペック §アーキテクチャ)。removeAccessApp → removeInstanceRoute →
// stopAndDestroyVm はすべて冪等な port なので、progress を見ずに毎回全ステップ
// を実行し直す(途中失敗しても次回丸ごとリトライすれば安全 — 払い出しの
// ProvisionStep のような細かい進捗記録は不要)。全部成功で markDeleted、
// いずれか失敗で markFailed(手動介入。スペック §Instance 集約の状態機械:
// failed → deleting の再削除で再試行できる)。
export const runTeardown = (
  instance: Instance
): Effect.Effect<Instance, never, InstanceRepo | ProxmoxPort | CloudflarePort | TeamRepo> =>
  Effect.gen(function* () {
    const repo = yield* InstanceRepo
    const teams = yield* TeamRepo
    const proxmox = yield* ProxmoxPort
    const cloudflare = yield* CloudflarePort

    const team = yield* teams.findById(instance.teamId).pipe(
      Effect.orDie,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.dieMessage(`runTeardown: team ${instance.teamId} not found`),
          onSome: Effect.succeed
        })
      )
    )
    const hostname = hostnameFor(team.teamNumber, instance.index)

    const teardown: Effect.Effect<void, CloudflareError | ProxmoxError> = Effect.gen(function* () {
      yield* cloudflare.removeAccessApp(hostname)
      yield* cloudflare.removeInstanceRoute(hostname)
      yield* proxmox.stopAndDestroyVm(instance.vmid)
    })

    return yield* teardown.pipe(
      Effect.matchEffect({
        onSuccess: () =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const deleted = Either.getOrThrow(markDeleted(instance, now))
            yield* repo
              .update(deleted)
              .pipe(Effect.catchAll((e) => Effect.logError(`persist deleted failed: ${describeError(e)}`)))
            return deleted
          }),
        onFailure: (error) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const failed = markFailed(instance, describeError(error), now)
            yield* repo
              .update(failed)
              .pipe(Effect.catchAll((e) => Effect.logError(`persist failed-state failed: ${describeError(e)}`)))
            return failed
          })
      })
    )
  })

// ワーカー(provisioner.ts)が 1 tick ごとに呼ぶ入口。findNextForOrchestration
// で creating/deleting のうち最も古い 1 件だけを取得し、その saga を完了させて
// から返す(全体で同時 1 インスタンスのみオーケストレーションする制約は、
// ワーカーが並行 fork せずここを直列に呼ぶことで満たされる。スペック
// §アーキテクチャ、BenchJob の全体 running 1 本と同型の設計意図)。処理対象が
// 無ければ None。findNextForOrchestration 自体が RepoError で失敗しても
// ワーカーを止めない(この tick は何もしなかった扱いにする)。
export const runNextOrchestrationStep: Effect.Effect<
  Option.Option<Instance>,
  never,
  InstanceRepo | ProxmoxPort | CloudflarePort | GithubKeysPort | TeamRepo | ProvisioningConfig
> = Effect.gen(function* () {
  const repo = yield* InstanceRepo
  const next = yield* repo.findNextForOrchestration.pipe(
    Effect.tapError((e) => Effect.logError(`findNextForOrchestration failed: ${describeError(e)}`)),
    Effect.catchAll(() => Effect.succeed(Option.none<Instance>()))
  )
  return yield* Option.match(next, {
    onNone: () => Effect.succeed(Option.none<Instance>()),
    onSome: (instance) =>
      (instance.status === "creating" ? runProvisioning(instance) : runTeardown(instance)).pipe(
        Effect.map(Option.some)
      )
  })
})
