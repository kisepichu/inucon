import { Clock, Effect, Either, Option } from "effect"
import { addStep, markDeleted, markFailed, markProvisioned } from "../../domain/instance.js"
import type { Instance, ProvisionStep } from "../../domain/instance.js"
import type { TeamId } from "../../domain/ids.js"
import { InsufficientMemory } from "../errors.js"
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

    // 逆順の補償(Task 4 レビュー C1 修正): access_done → route_done → VM 破棄を
    // progress の内容に関わらず毎回すべて試みる。理由は「clone 成功直後・
    // progress 保存前にプロセスが落ちた」場合、instance.progress には
    // clone_done が記録されておらず、旧実装(progress を見て絞る)だと
    // stopAndDestroyVm が呼ばれず孤児 VM が残ってしまうため。
    // removeAccessApp/removeInstanceRoute/stopAndDestroyVm はすべて冪等
    // (対象が無くても成功する)なので、progress に無関係に全部呼んでよい
    // (呼んでも実害が無い一方、呼び漏らすと孤児資源が残る非対称なリスクの
    // ほうが大きい)。各補償ステップの失敗はログに残して次へ進む(1 つの
    // 補償失敗で残りの補償を諦めない、TimeoutSweeper と同じ生存性優先)。
    const compensate = (instance: Instance) =>
      Effect.gen(function* () {
        yield* cloudflare
          .removeAccessApp(hostname)
          .pipe(Effect.catchAll((e) => Effect.logError(`compensate removeAccessApp failed: ${describeError(e)}`)))
        yield* cloudflare
          .removeInstanceRoute(hostname)
          .pipe(Effect.catchAll((e) => Effect.logError(`compensate removeInstanceRoute failed: ${describeError(e)}`)))
        yield* proxmox
          .stopAndDestroyVm(instance.vmid)
          .pipe(Effect.catchAll((e) => Effect.logError(`compensate stopAndDestroyVm failed: ${describeError(e)}`)))
      })

    const advance = Effect.gen(function* () {
      let instance = initial

      if (!instance.progress.includes("clone_done")) {
        // 再入可能性(Task 4 レビュー C1): 前回の実行が cloneVm 成功後・
        // progress 保存前に落ちていると、instance.progress には clone_done が
        // 無いままだが Proxmox 上には既に vmid の VM が存在する。vmidFor は
        // 決定的なので、そのまま cloneVm を呼び直すと同一 vmid への二重 clone
        // になり Proxmox 側で失敗する(復旧不能)。事前に vmExists で確認し、
        // 既に存在すれば cloneVm をスキップして clone_done 扱いにする。
        const alreadyExists = yield* proxmox.vmExists(instance.vmid)
        if (!alreadyExists) {
          // RAM ガードの再検証(Task 4 レビュー I2): requestCreateInstance の
          // admission 時点のガードは「追加ボタンを押した瞬間」の空き容量しか
          // 見ていない。複数チームが同時に追加すると、ワーカーが順番に
          // clone するまでの間に他インスタンスの clone で実際の空きが
          // 閾値を割り込みうる。実際に VM を作る(cloneVm を呼ぶ)直前に
          // 再確認し、閾値未満なら InsufficientMemory で fail させる(saga の
          // 失敗経路に乗せ、補償 → markFailed へ畳み込む)。既に vmExists な
          // 場合は新規に容量を消費しないため再検証は不要。
          const freeBytes = yield* proxmox.getNodeFreeMemBytes
          if (freeBytes < config.minFreeMemBytes) {
            return yield* Effect.fail(
              new InsufficientMemory({ freeBytes, requiredBytes: config.minFreeMemBytes })
            )
          }
          yield* proxmox.cloneVm({
            templateVmid: TEMPLATE_VMID,
            newVmid: instance.vmid,
            name: `inucon-team${team.teamNumber}-${instance.index}`
          })
        }
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
