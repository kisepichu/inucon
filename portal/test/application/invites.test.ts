import { it } from "@effect/vitest"
import { Effect, Exit, Layer, Option } from "effect"
import { describe, expect } from "vitest"
import { AuthConfig, TeamRepo, UserRepo } from "../../src/application/ports.js"
import { MemberConflict, TeamNotFound } from "../../src/application/errors.js"
import { handleOAuthCallback } from "../../src/application/usecases/auth.js"
import { inviteMember, listInvites } from "../../src/application/usecases/invites.js"
import { hostnameFor } from "../../src/application/usecases/provisioning.js"
import { InstanceId, TeamId, UserId } from "../../src/domain/ids.js"
import { Instance, ipFor, vmidFor } from "../../src/domain/instance.js"
import { Team } from "../../src/domain/team.js"
import { TeamInvite } from "../../src/domain/teamInvite.js"
import { User } from "../../src/domain/user.js"
import { makeGithubOAuthStub } from "../support/githubOAuthStub.js"
import {
  makeCloudflarePortTest,
  makeGithubKeysPortTest,
  makeInstanceRepoTest,
  makeInviteReposTest,
  makeProxmoxPortTest
} from "../support/inMemory.js"

// team1(teamNumber=1)は running インスタンス 1 件を持つ(Access/鍵同期の
// 対象)。team2(teamNumber=2)は他チーム所属判定(MemberConflict)専用。
const team1Id = TeamId.make("11111111-1111-1111-1111-111111111111")
const team2Id = TeamId.make("22222222-2222-2222-2222-222222222222")
const team1 = new Team({ id: team1Id, name: "team1", teamNumber: 1 })
const team2 = new Team({ id: team2Id, name: "team2", teamNumber: 2 })

const aliceId = UserId.make("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
const bobId = UserId.make("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
const carolId = UserId.make("cccccccc-cccc-cccc-cccc-cccccccccccc")

// alice: team1 既存メンバー、email/鍵あり。bob: team1 既存メンバーだが email
// 未設定(missingEmailLogins 検証用)。carol: team2 既存メンバー(他チーム
// 所属判定用)。
const alice = new User({
  id: aliceId,
  githubId: 1,
  githubLogin: "alice",
  displayName: "Alice",
  isAdmin: false,
  email: Option.some("alice@example.com")
})
const bob = new User({
  id: bobId,
  githubId: 2,
  githubLogin: "bob",
  displayName: "Bob",
  isAdmin: false,
  email: Option.none()
})
const carol = new User({
  id: carolId,
  githubId: 3,
  githubLogin: "carol",
  displayName: "Carol",
  isAdmin: false,
  email: Option.some("carol@example.com")
})

const vmid1 = vmidFor(1, 1)
const ip1 = ipFor(1, 1)
const hostname1 = hostnameFor(1, 1)

const runningInstanceTeam1 = new Instance({
  id: InstanceId.make("instance-1"),
  teamId: team1Id,
  index: 1,
  vmid: vmid1,
  privateIp: ip1,
  status: "running",
  progress: ["clone_done", "configured", "started", "route_done", "access_done"],
  errorMessage: Option.none(),
  createdAt: 0,
  updatedAt: 0
})

// テストごとに独立した Ref を持つ Layer を組み立てる(state 汚染を防ぐため
// 各 it.effect でこの factory を呼ぶ。provisioning.test.ts の sagaLayer と
// 同じ方針)。呼び出し側は、返る layer を Effect.gen ブロック全体に対して
// 1 回だけ Effect.provide する(個々の yield* ごとに provide すると、その
// 都度 Layer が再構築されて Ref が初期状態に戻ってしまい、複数ステップに
// またがる状態(招待→初ログイン等)を確認できないため)。
const baseLayer = (
  opts: {
    users?: ReadonlyArray<User>
    memberships?: ReadonlyArray<{ userId: UserId; teamId: TeamId }>
    invites?: ReadonlyArray<TeamInvite>
    instances?: ReadonlyArray<Instance>
    githubKeysByLogin?: Record<string, ReadonlyArray<string>>
  } = {}
) => {
  const proxmox = makeProxmoxPortTest()
  const cloudflare = makeCloudflarePortTest()
  const reposLayer = makeInviteReposTest({
    teams: [team1, team2],
    users: opts.users ?? [alice, bob, carol],
    memberships: opts.memberships ?? [
      { userId: aliceId, teamId: team1Id },
      { userId: bobId, teamId: team1Id },
      { userId: carolId, teamId: team2Id }
    ],
    invites: opts.invites ?? []
  })
  const layer = Layer.mergeAll(
    reposLayer,
    makeInstanceRepoTest(opts.instances ?? [runningInstanceTeam1]),
    makeGithubKeysPortTest(
      opts.githubKeysByLogin ?? {
        alice: ["ssh-ed25519 AAAA alice@host"],
        bob: ["ssh-rsa BBBB bob@host"]
      }
    ),
    proxmox.layer,
    cloudflare.layer
  )
  return { layer, proxmox, cloudflare }
}

describe("inviteMember", () => {
  it.effect("未ログインユーザー(users に不在)への招待は team_invites を作成し pending を返す", () => {
    const { layer } = baseLayer()
    return Effect.gen(function* () {
      const result = yield* inviteMember({ teamId: team1Id, githubLogin: "newbie", email: "newbie@example.com" })
      expect(result.portal).toBe("pending")

      const invites = yield* listInvites(team1Id)
      expect(invites.map((i) => i.githubLogin)).toStrictEqual(["newbie"])
      expect(invites[0].email).toBe("newbie@example.com")
    }).pipe(Effect.provide(layer))
  })

  it.effect("初ログインで team_invites を自動消費: 所属+email引き継ぎ+invite削除", () => {
    const { layer } = baseLayer()
    const authLayer = Layer.mergeAll(
      layer,
      makeGithubOAuthStub({ "code-newbie": { githubId: 42, githubLogin: "newbie", displayName: "Newbie" } }),
      Layer.succeed(AuthConfig, { adminGithubLogins: [] })
    )
    return Effect.gen(function* () {
      yield* inviteMember({ teamId: team1Id, githubLogin: "newbie", email: "newbie@example.com" })

      const { user } = yield* handleOAuthCallback({ code: "code-newbie" })
      expect(Option.getOrNull(user.email)).toBe("newbie@example.com")

      const teams = yield* TeamRepo
      const newbieTeam = yield* teams.findByUserId(user.id)
      expect(newbieTeam).toStrictEqual(Option.some(team1))

      // invite 行は消費(削除)される。
      const invites = yield* listInvites(team1Id)
      expect(invites).toStrictEqual([])
    }).pipe(Effect.provide(authLayer))
  })

  it.effect("既ログインユーザー(users に存在)への招待は即所属+email更新", () => {
    // dave はどのチームにも未所属の既存ユーザー。
    const daveId = UserId.make("dddddddd-dddd-dddd-dddd-dddddddddddd")
    const dave = new User({
      id: daveId,
      githubId: 4,
      githubLogin: "dave",
      displayName: "Dave",
      isAdmin: false,
      email: Option.none()
    })
    const { layer } = baseLayer({ users: [alice, bob, carol, dave] })

    return Effect.gen(function* () {
      const result = yield* inviteMember({ teamId: team1Id, githubLogin: "dave", email: "dave@example.com" })
      expect(result.portal).toBe("assigned")

      const teams = yield* TeamRepo
      const daveTeam = yield* teams.findByUserId(daveId)
      expect(daveTeam).toStrictEqual(Option.some(team1))

      const users = yield* UserRepo
      const updatedDave = yield* users.findById(daveId)
      expect(Option.getOrNull(Option.flatMap(updatedDave, (u) => u.email))).toBe("dave@example.com")
    }).pipe(Effect.provide(layer))
  })

  it.effect("他チームに既に所属するユーザーへの招待は MemberConflict(横取りしない)", () => {
    const { layer } = baseLayer()
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        inviteMember({ teamId: team1Id, githubLogin: "carol", email: "carol-new@example.com" })
      )
      expect(exit).toStrictEqual(Exit.fail(new MemberConflict({ logins: ["carol"] })))

      // 横取りされていない(team2 のメンバーのまま)。
      const teams = yield* TeamRepo
      const stillInTeam2 = yield* teams.findByUserId(carolId)
      expect(stillInTeam2).toStrictEqual(Option.some(team2))
    }).pipe(Effect.provide(layer))
  })

  it.effect("存在しないチームへの招待は TeamNotFound", () => {
    const { layer } = baseLayer()
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        inviteMember({ teamId: TeamId.make("no-such-team"), githubLogin: "alice", email: "x@example.com" })
      )
      expect(exit).toStrictEqual(Exit.fail(new TeamNotFound()))
    }).pipe(Effect.provide(layer))
  })

  it.effect("Access は現メンバー∪招待中(team_invites)の和集合で更新される", () => {
    const { cloudflare, layer } = baseLayer({
      invites: [
        new TeamInvite({ githubLogin: "pending1", teamId: team1Id, email: "pending1@example.com", invitedAt: 0 })
      ]
    })

    return Effect.gen(function* () {
      const result = yield* inviteMember({ teamId: team1Id, githubLogin: "newcomer", email: "newcomer@example.com" })
      expect(result.access.ok).toBe(true)

      const cf = yield* cloudflare.getState
      // alice(既存メンバー、email あり)+ pending1(既存招待)+ newcomer(今回の
      // 招待)の和集合。bob は email 未設定なので載らない。
      expect([...cf.accessEmailsByHostname[hostname1]].sort()).toStrictEqual(
        ["alice@example.com", "newcomer@example.com", "pending1@example.com"].sort()
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect('running インスタンスへ検証済み鍵のみを注入する(printf "%s\\n" 形式)', () => {
    const { proxmox, layer } = baseLayer({
      githubKeysByLogin: {
        alice: ["ssh-ed25519 AAAA alice@host"],
        bob: ["ssh-rsa BBBB bob@host"],
        newcomer: ["ssh-ed25519 CCCC newcomer@host"]
      }
    })

    return Effect.gen(function* () {
      const result = yield* inviteMember({
        teamId: team1Id,
        githubLogin: "newcomer",
        email: "newcomer@example.com"
      })

      expect(result.sshKeys).toStrictEqual([{ instance: runningInstanceTeam1.id, ok: true }])

      const px = yield* proxmox.getState
      expect([...px.authorizedKeysByVmid[vmid1]].sort()).toStrictEqual(
        ["ssh-ed25519 AAAA alice@host", "ssh-rsa BBBB bob@host", "ssh-ed25519 CCCC newcomer@host"].sort()
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("email 未登録メンバー(bob)は warnings に githubLogin が載る", () => {
    const { layer } = baseLayer()
    return Effect.gen(function* () {
      const result = yield* inviteMember({
        teamId: team1Id,
        githubLogin: "newcomer",
        email: "newcomer@example.com"
      })
      expect(result.warnings).toStrictEqual(["bob"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("同一招待の再実行は冪等(重複所属・重複鍵にならない)", () => {
    const { proxmox, layer } = baseLayer()

    return Effect.gen(function* () {
      const first = yield* inviteMember({
        teamId: team1Id,
        githubLogin: "newcomer",
        email: "newcomer@example.com"
      })
      const second = yield* inviteMember({
        teamId: team1Id,
        githubLogin: "newcomer",
        email: "newcomer@example.com"
      })

      expect(first.portal).toBe("pending")
      expect(second.portal).toBe("pending")

      const invites = yield* listInvites(team1Id)
      // github_login が PK の upsert なので重複行にならない。
      expect(invites.map((i) => i.githubLogin)).toStrictEqual(["newcomer"])

      // 鍵の重複追記も無い(alice/bob の鍵のみ、2 回実行しても件数は同じ)。
      const px = yield* proxmox.getState
      expect(px.authorizedKeysByVmid[vmid1]).toHaveLength(2)
    }).pipe(Effect.provide(layer))
  })

  it.effect("既存メンバーへの再招待(冪等): 二重所属にならない", () => {
    const { layer } = baseLayer()

    return Effect.gen(function* () {
      yield* inviteMember({ teamId: team1Id, githubLogin: "alice", email: "alice-new@example.com" })
      yield* inviteMember({ teamId: team1Id, githubLogin: "alice", email: "alice-new@example.com" })

      const teams = yield* TeamRepo
      const members = yield* teams.listMembers(team1Id)
      expect(members.filter((m) => m.id === aliceId)).toHaveLength(1)

      const users = yield* UserRepo
      const updatedAlice = yield* users.findById(aliceId)
      expect(Option.getOrNull(Option.flatMap(updatedAlice, (u) => u.email))).toBe("alice-new@example.com")
    }).pipe(Effect.provide(layer))
  })
})
