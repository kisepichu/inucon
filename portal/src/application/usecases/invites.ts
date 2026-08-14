import { Clock, Effect, Either, Option } from "effect"
import type { Team } from "../../domain/team.js"
import { TeamInvite } from "../../domain/teamInvite.js"
import type { ContestId, InstanceId, TeamId } from "../../domain/ids.js"
import { ContestNotFound, MemberConflict, TeamNotFound } from "../errors.js"
import { ContestRepo, CloudflarePort, GithubKeysPort, InstanceRepo, InviteRepo, ProxmoxPort, TeamRepo, UserRepo } from "../ports.js"
import { collectTeamAccess, describeError, hostnameFor } from "./provisioning.js"

// isucon ユーザーの authorized_keys(spike メモ・provisioning.ts のコメント
// 「isucon ユーザー」実績と同じパス)。
const AUTHORIZED_KEYS_PATH = "/home/isucon/.ssh/authorized_keys"

// printf の書式文字列。シェルではなく printf 自身が \n を解釈するよう、
// 実行時の文字列としてはバックスラッシュ+n の2文字リテラルにする(コード側の
// 定数であり鍵ではないので argv に混ぜても安全)。
const PRINTF_FORMAT = "%s\\n"

// authorized_keys への冪等な追記コマンド(スペック §招待フロー「重複追記は
// 排除」、§セキュリティ「guestExec の使途限定: コマンドはコード内固定...
// ユーザー入力が混ざるのは鍵文字列だけで...argv 分離」)。
// /bin/sh -c 本体には鍵・書式とも埋め込まず、位置引数($1 以降)として渡す:
//   $0(未使用のダミー)/$1(書き込み先パス)/$2("printf")/$3(書式)/$4(鍵)
// スクリプトは grep -qxF で既に同一行が無いことを確認してから
// "$2" "$3" "$4"(= printf "%s\n" "<鍵>")を "$1" へ追記する。
export const appendAuthorizedKeyCommand = (key: string): ReadonlyArray<string> => [
  "/bin/sh",
  "-c",
  'grep -qxF "$4" "$1" 2>/dev/null || "$2" "$3" "$4" >> "$1"',
  "sh",
  AUTHORIZED_KEYS_PATH,
  "printf",
  PRINTF_FORMAT,
  key
]

export interface InviteSshKeyResult {
  readonly instance: InstanceId
  readonly ok: boolean
  readonly error?: string
}

export interface InviteAccessResult {
  readonly ok: boolean
  readonly error?: string
}

export interface InviteResult {
  readonly portal: "assigned" | "pending"
  readonly access: InviteAccessResult
  readonly sshKeys: ReadonlyArray<InviteSshKeyResult>
  readonly warnings: ReadonlyArray<string>
}

// チームの全 running インスタンスへ「現メンバー ∪ 招待中」の Access/鍵を
// 同期する(スペック §招待フロー 2-3)。inviteMember から呼ばれる。全ステップ
// 冪等(ensureAccessApp は和集合 PUT、guestExec の追記コマンドは grep で
// 重複排除)なので、同じ招待を何度実行しても安全に「埋まる」。
const syncRunningInstances = (
  contestId: ContestId,
  teamId: TeamId,
  team: Team
): Effect.Effect<
  { access: InviteAccessResult; sshKeys: ReadonlyArray<InviteSshKeyResult>; warnings: ReadonlyArray<string> },
  never,
  InstanceRepo | CloudflarePort | ProxmoxPort | TeamRepo | InviteRepo | GithubKeysPort
> =>
  Effect.gen(function* () {
    const instances = yield* InstanceRepo
    const cloudflare = yield* CloudflarePort
    const proxmox = yield* ProxmoxPort

    const all = yield* instances.listByTeam(contestId, teamId).pipe(Effect.orDie)
    const running = all.filter((i) => i.status === "running")

    const access = yield* collectTeamAccess(contestId, teamId).pipe(Effect.orDie)

    let accessOk = true
    let accessError: string | undefined
    for (const instance of running) {
      const hostname = hostnameFor(team.teamNumber, instance.index)
      const result = yield* Effect.either(cloudflare.ensureAccessApp({ hostname, emails: access.emails }))
      if (Either.isLeft(result)) {
        accessOk = false
        accessError = describeError(result.left)
      }
    }

    const sshKeys = yield* Effect.forEach(running, (instance) =>
      Effect.gen(function* () {
        const results = yield* Effect.forEach(access.sshKeys, (key) =>
          Effect.either(proxmox.guestExec({ vmid: instance.vmid, command: appendAuthorizedKeyCommand(key) }))
        )
        const failed = results.find(Either.isLeft)
        if (failed !== undefined && Either.isLeft(failed)) {
          return { instance: instance.id, ok: false, error: describeError(failed.left) } as InviteSshKeyResult
        }
        return { instance: instance.id, ok: true } as InviteSshKeyResult
      })
    )

    return {
      access: accessOk ? { ok: true } : { ok: false, error: accessError ?? "unknown error" },
      sshKeys,
      warnings: access.missingEmailLogins
    }
  })

// POST /api/admin/teams/:id/invites(admin のみ、スペック §招待フロー):
// 1. users に存在すれば即所属(team_members へ INSERT)+ email 更新。
//    既に他チームに所属していれば MemberConflict(409)。同一チームに
//    既に所属していれば email 更新のみ(冪等)。
//    findByUserId で「未所属」と判定してから addMember するまでの間に別の
//    招待が同一ユーザーを別チームへ追加する競合(TOCTOU)は、addMember 自体
//    (TeamRepo.addMember)が原子的に「追加できたか」を返すことで検出する。
//    追加できなかった場合は実際の所属先を再確認し、要求チームと同じなら
//    冪等成功、異なれば MemberConflict とする。
// 2. 存在しなければ team_invites に upsert(初ログイン時に auth.ts が消費)。
// 3. どちらの場合も、そのチームの全 running インスタンスへ Access/鍵を
//    同期する(syncRunningInstances、全ステップ冪等)。
// POST /api/admin/teams/:id/invites(admin のみ、Task 3 更新)。互換用の
// この handler は「今 operational な contest」を解決してから scoped 版を呼ぶ。
// Task 5 で contest 明示 endpoint が入るとそこから inviteMemberScoped を
// 直接呼べる(scope は同じ、resolve だけこちらで行う)。
export const inviteMember = (args: {
  teamId: TeamId
  githubLogin: string
  email: string
}): Effect.Effect<
  InviteResult,
  ContestNotFound | TeamNotFound | MemberConflict,
  ContestRepo | TeamRepo | UserRepo | InviteRepo | InstanceRepo | CloudflarePort | ProxmoxPort | GithubKeysPort
> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const contest = yield* contests.getOperational.pipe(
      Effect.orDie,
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
    )
    return yield* inviteMemberScoped({ ...args, contestId: contest.id })
  })

export const inviteMemberScoped = (args: {
  contestId: ContestId
  teamId: TeamId
  githubLogin: string
  email: string
}): Effect.Effect<
  InviteResult,
  TeamNotFound | MemberConflict,
  TeamRepo | UserRepo | InviteRepo | InstanceRepo | CloudflarePort | ProxmoxPort | GithubKeysPort
> =>
  Effect.gen(function* () {
    const teams = yield* TeamRepo
    const team = yield* teams.findById(args.contestId, args.teamId).pipe(
      Effect.orDie,
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new TeamNotFound()), onSome: Effect.succeed }))
    )

    const users = yield* UserRepo
    const found = yield* users.findManyByGithubLogins([args.githubLogin]).pipe(Effect.orDie)
    const user = found[0]

    let portal: "assigned" | "pending"
    if (user !== undefined) {
      const currentTeam = yield* teams.findByUserId(args.contestId, user.id).pipe(Effect.orDie)
      if (Option.isSome(currentTeam) && currentTeam.value.id !== args.teamId) {
        return yield* Effect.fail(new MemberConflict({ logins: [args.githubLogin] }))
      }
      if (Option.isNone(currentTeam)) {
        const added = yield* teams.addMember(args.contestId, args.teamId, user.id).pipe(Effect.orDie)
        if (!added) {
          const actualTeam = yield* teams.findByUserId(args.contestId, user.id).pipe(Effect.orDie)
          if (Option.isNone(actualTeam) || actualTeam.value.id !== args.teamId) {
            return yield* Effect.fail(new MemberConflict({ logins: [args.githubLogin] }))
          }
        }
      }
      yield* users.setEmail(user.id, args.email).pipe(Effect.orDie)
      portal = "assigned"
    } else {
      const invites = yield* InviteRepo
      const now = yield* Clock.currentTimeMillis
      yield* invites
        .create(
          new TeamInvite({
            contestId: args.contestId,
            githubLogin: args.githubLogin,
            teamId: args.teamId,
            email: args.email,
            invitedAt: now
          })
        )
        .pipe(Effect.orDie)
      portal = "pending"
    }

    const sync = yield* syncRunningInstances(args.contestId, args.teamId, team)

    return { portal, ...sync }
  })

// GET /api/admin/teams/:id/invites(admin のみ)。互換 handler は operational
// な contest を解決する。
export const listInvites = (
  teamId: TeamId
): Effect.Effect<
  ReadonlyArray<TeamInvite>,
  ContestNotFound | TeamNotFound,
  ContestRepo | TeamRepo | InviteRepo
> =>
  Effect.gen(function* () {
    const contests = yield* ContestRepo
    const contest = yield* contests.getOperational.pipe(
      Effect.orDie,
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed }))
    )
    return yield* listInvitesScoped(contest.id, teamId)
  })

export const listInvitesScoped = (
  contestId: ContestId,
  teamId: TeamId
): Effect.Effect<ReadonlyArray<TeamInvite>, TeamNotFound, TeamRepo | InviteRepo> =>
  Effect.gen(function* () {
    const teams = yield* TeamRepo
    yield* teams.findById(contestId, teamId).pipe(
      Effect.orDie,
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new TeamNotFound()), onSome: Effect.succeed }))
    )
    const invites = yield* InviteRepo
    return yield* invites.listByTeam(contestId, teamId).pipe(Effect.orDie)
  })
