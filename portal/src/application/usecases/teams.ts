import { Effect, Either, Option } from "effect"
import { TeamId } from "../../domain/ids.js"
import { Team } from "../../domain/team.js"
import type { User } from "../../domain/user.js"
import { MemberConflict, TeamNotFound, UnknownGithubLogins } from "../errors.js"
import { TeamRepo, UserRepo, UuidGen } from "../ports.js"

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

