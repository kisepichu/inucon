import { Effect, Option } from "effect"
import type { ContestId, TeamId } from "../../domain/ids.js"
import { TeamId as TeamIdBrand } from "../../domain/ids.js"
import { Team } from "../../domain/team.js"
import type { User } from "../../domain/user.js"
import { ContestNotFound, MemberConflict, TeamNotFound, UnknownGithubLogins } from "../errors.js"
import { ContestRepo, TeamRepo, UserRepo, UuidGen } from "../ports.js"

// Task 3: compat handler は「今 operational な contest」を解決してから scoped
// repo を呼ぶ。0 contest 状態(admin が draft を作る前)は ContestNotFound。
// Task 5 で明示 contestId を受ける path が入り、この resolveOperationalContestId
// はそのまま /api/contests/:contestId/... 系の下敷きになる。
const resolveOperationalContestId = ContestRepo.pipe(
  Effect.flatMap((repo) => repo.getOperational),
  Effect.flatMap(Option.match({ onNone: () => Effect.fail(new ContestNotFound()), onSome: Effect.succeed })),
  Effect.map((c) => c.id)
)

// GET /api/teams: operational な contest のチーム一覧 + メンバー(githubLogin
// 込み)。チーム数は小規模(コンテスト運営規模)前提で N+1 のまま素直に書く。
export const listTeamsWithMembers = Effect.gen(function* () {
  const contestId = yield* resolveOperationalContestId
  const teams = yield* TeamRepo
  const all = yield* teams.listByContest(contestId)
  return yield* Effect.forEach(all, (team) =>
    teams.listMembers(contestId, team.id).pipe(Effect.map((members) => ({ team, members })))
  )
})

// POST /api/teams: 現在の operational contest に新規チームを作る。desiredInstance
// Count は現状 admin UI 未対応のため既定 3(Task 5 で wizard から明示指定)。
// 重複 teamNumber は TeamRepo.create が TeamNumberConflict(409)。
export const createTeam = (args: { name: string; teamNumber: number }) =>
  Effect.gen(function* () {
    const contestId = yield* resolveOperationalContestId
    const uuidGen = yield* UuidGen
    const id = TeamIdBrand.make(yield* uuidGen.next)
    const team = new Team({
      id,
      contestId,
      name: args.name,
      teamNumber: args.teamNumber,
      desiredInstanceCount: 3
    })
    const teams = yield* TeamRepo
    yield* teams.create(team)
    return team
  })

// PUT /api/teams/:id/members(scoped 全量置換)。
export const setTeamMembers = (args: { teamId: TeamId; githubLogins: ReadonlyArray<string> }) =>
  Effect.gen(function* () {
    const contestId = yield* resolveOperationalContestId
    return yield* setTeamMembersScoped({ contestId, teamId: args.teamId, githubLogins: args.githubLogins })
  })

// contestId 明示版(Task 5 の contest-scoped admin endpoint 実装で直接呼ぶ)。
export const setTeamMembersScoped = (args: {
  contestId: ContestId
  teamId: TeamId
  githubLogins: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    // ペイロード内の重複 login は team_members の PK 違反(500)を招くので排除。
    const logins = [...new Set(args.githubLogins)]

    const teams = yield* TeamRepo
    const team = yield* teams.findById(args.contestId, args.teamId).pipe(
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
      const currentTeam = yield* teams.findByUserId(args.contestId, user.id)
      if (Option.isSome(currentTeam) && currentTeam.value.id !== args.teamId) {
        conflicts.push(login)
      }
    }
    if (conflicts.length > 0) {
      return yield* Effect.fail(new MemberConflict({ logins: conflicts }))
    }

    const userIds = logins.map((login) => foundByLogin.get(login)!.id)
    yield* teams.setMembers(args.contestId, args.teamId, userIds)

    const members = yield* teams.listMembers(args.contestId, args.teamId)
    return { team, members }
  })
