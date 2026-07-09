import { Effect, Either, Option } from "effect"
import { validateBenchTarget } from "../../domain/subnet.js"
import { InstanceId, TeamId } from "../../domain/ids.js"
import { Instance } from "../../domain/instance.js"
import { Team } from "../../domain/team.js"
import type { User } from "../../domain/user.js"
import { Forbidden, MemberConflict, TeamNotFound, UnknownGithubLogins } from "../errors.js"
import { InstanceRepo, TeamRepo, UserRepo, UuidGen } from "../ports.js"

// GET /api/teams: 一覧 + 各チームのメンバー(githubLogin 込み)。チーム数は
// 小規模(コンテスト運営規模)前提で N+1 のまま素直に書く。
export const listTeamsWithMembers = Effect.gen(function* () {
  const teams = yield* TeamRepo
  const all = yield* teams.list
  return yield* Effect.forEach(all, (team) =>
    teams.listMembers(team.id).pipe(Effect.map((members) => ({ team, members })))
  )
})

// POST /api/teams: 重複 teamNumber は TeamRepo.create が TeamNumberConflict
// で返す(呼び出し元のハンドラが 409 にマップする)。
export const createTeam = (args: { name: string; teamNumber: number }) =>
  Effect.gen(function* () {
    const uuidGen = yield* UuidGen
    const id = TeamId.make(yield* uuidGen.next)
    const team = new Team({ id, name: args.name, teamNumber: args.teamNumber })
    const teams = yield* TeamRepo
    yield* teams.create(team)
    return team
  })

// PUT /api/teams/:id/members: 全量置換。
// 1. 対象チームが存在するか(NotFound)
// 2. 渡された githubLogins が全員 users に実在するか(未ログインは
//    UnknownGithubLogins、422)
// 3. 実在する場合、既に他チームに所属していないか(他チーム所属を黙って
//    横取りしないよう MemberConflict、409)
// を順にチェックしてから setMembers する。
export const setTeamMembers = (args: { teamId: TeamId; githubLogins: ReadonlyArray<string> }) =>
  Effect.gen(function* () {
    // ペイロード内の重複 login はそのまま INSERT すると team_members の
    // PRIMARY KEY (team_id, user_id) 違反(RepoError → 500)になるため、
    // 先頭出現順を保って重複排除する。
    const logins = [...new Set(args.githubLogins)]

    const teams = yield* TeamRepo
    const team = yield* teams.findById(args.teamId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new TeamNotFound()), onSome: Effect.succeed }))
    )

    const users = yield* UserRepo
    const found = yield* users.findManyByGithubLogins(logins)
    const foundByLogin = new Map(found.map((u) => [u.githubLogin, u] as const))

    const unknown = logins.filter((login) => !foundByLogin.has(login))
    if (unknown.length > 0) {
      return yield* Effect.fail(new UnknownGithubLogins({ logins: unknown }))
    }

    const conflicts: Array<string> = []
    for (const login of logins) {
      const user = foundByLogin.get(login)!
      const currentTeam = yield* teams.findByUserId(user.id)
      if (Option.isSome(currentTeam) && currentTeam.value.id !== args.teamId) {
        conflicts.push(login)
      }
    }
    if (conflicts.length > 0) {
      return yield* Effect.fail(new MemberConflict({ logins: conflicts }))
    }

    const userIds = logins.map((login) => foundByLogin.get(login)!.id)
    yield* teams.setMembers(args.teamId, userIds)

    const members = yield* teams.listMembers(args.teamId)
    return { team, members }
  })

// GET /api/teams/:id/instances: 当該チームメンバー or admin のみ参照可
// (他チームは Forbidden、403)。対象チームが存在しない場合は TeamNotFound。
export const listTeamInstances = (args: { user: User; teamId: TeamId }) =>
  Effect.gen(function* () {
    const teams = yield* TeamRepo
    yield* teams.findById(args.teamId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new TeamNotFound()), onSome: Effect.succeed }))
    )

    if (!args.user.isAdmin) {
      const ownTeam = yield* teams.findByUserId(args.user.id)
      const isMember = Option.isSome(ownTeam) && ownTeam.value.id === args.teamId
      if (!isMember) {
        return yield* Effect.fail(new Forbidden())
      }
    }

    const instances = yield* InstanceRepo
    return yield* instances.listByTeam(args.teamId)
  })

// POST /api/instances: privateIp がチームサブネット外なら domain の
// validateBenchTarget が TargetIpOutOfSubnet を返す(422 にマップ)。同一
// (team, index) の重複は InstanceRepo.create が DuplicateInstanceIndex を
// 返す(409 にマップ)。
export const createInstance = (args: { teamId: TeamId; index: number; privateIp: string }) =>
  Effect.gen(function* () {
    const teams = yield* TeamRepo
    const team = yield* teams.findById(args.teamId).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new TeamNotFound()), onSome: Effect.succeed }))
    )

    yield* Either.match(validateBenchTarget(args.privateIp, team.teamNumber), {
      onLeft: Effect.fail,
      onRight: Effect.succeed
    })

    const uuidGen = yield* UuidGen
    const id = InstanceId.make(yield* uuidGen.next)
    const instance = new Instance({
      id,
      teamId: args.teamId,
      index: args.index,
      privateIp: args.privateIp,
      status: "active"
    })

    const instances = yield* InstanceRepo
    return yield* instances.create(instance)
  })

// DELETE /api/instances/:id: logout と同様に冪等(存在しない id でも成功)にする。
export const removeInstance = (args: { instanceId: InstanceId }) =>
  InstanceRepo.pipe(Effect.flatMap((repo) => repo.remove(args.instanceId)))
