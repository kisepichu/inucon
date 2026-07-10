import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { CloudflareError, CloudflarePort, GithubKeysError, GithubKeysPort, ProvisionTimeout, ProxmoxError, ProxmoxPort } from "../../src/application/ports.js"
import { makeCloudflarePortTest, makeGithubKeysPortTest, makeProxmoxPortTest } from "./inMemory.js"

// Phase 3(Task 3)のインメモリ port 実装自体の健全性テスト。Task 4 の saga
// テストがこれらに依存するため、ports.ts の意味論(冪等性・和集合・失敗注入)を
// 満たしていることをここで先に確認する。

describe("makeProxmoxPortTest", () => {
  it.effect("呼び出しが getState に反映される", () =>
    Effect.gen(function* () {
      const { getState, layer } = makeProxmoxPortTest()
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) =>
          Effect.gen(function* () {
            yield* px.cloneVm({ templateVmid: 9100, newVmid: 1101, name: "x" })
            yield* px.configureCloudInit({ vmid: 1101, ip: "10.100.1.11", gateway: "10.100.1.1", sshKeys: "k" })
            yield* px.setVnet({ vmid: 1101, bridge: "team1" })
            yield* px.startVm(1101)
          })
        ),
        Effect.provide(layer)
      )
      const state = yield* getState
      expect(state.clonedVmids).toStrictEqual([1101])
      expect(state.configuredVmids).toStrictEqual([1101])
      expect(state.vnetByVmid).toStrictEqual({ 1101: "team1" })
      expect(state.startedVmids).toStrictEqual([1101])
    })
  )

  it.effect("stopAndDestroyVm は冪等(2 回呼んでも 1 件)", () =>
    Effect.gen(function* () {
      const { getState, layer } = makeProxmoxPortTest()
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.stopAndDestroyVm(1101).pipe(Effect.andThen(px.stopAndDestroyVm(1101)))),
        Effect.provide(layer)
      )
      const state = yield* getState
      expect(state.destroyedVmids).toStrictEqual([1101])
    })
  )

  it.effect("guestExec で authorized_keys 追記コマンドを検出し、重複を除いて追記する", () =>
    Effect.gen(function* () {
      const { getState, layer } = makeProxmoxPortTest()
      const appendCommand = (key: string) => ["printf", "%s\\n", key]
      const key1 = "ssh-ed25519 AAAA a@b"
      const key2 = "ssh-rsa BBBB c@d"
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) =>
          Effect.gen(function* () {
            const r1 = yield* px.guestExec({ vmid: 1101, command: appendCommand(key1) })
            const r2 = yield* px.guestExec({ vmid: 1101, command: appendCommand(key2) })
            const r3 = yield* px.guestExec({ vmid: 1101, command: appendCommand(key1) })
            expect(r1.exitcode).toBe(0)
            expect(r3.out).toBe("2 authorized_keys\n")
          })
        ),
        Effect.provide(layer)
      )
      const state = yield* getState
      expect(state.authorizedKeysByVmid[1101]).toStrictEqual([key1, key2])
      expect(state.guestExecCalls).toHaveLength(3)
    })
  )

  it.effect("failWith で指定した操作は常に失敗する", () =>
    Effect.gen(function* () {
      const injected = new ProxmoxError({ cause: "boom" })
      const { layer } = makeProxmoxPortTest({ failWith: { startVm: injected } })
      const error = yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.startVm(1101)),
        Effect.provide(layer),
        Effect.flip
      )
      expect(error).toBe(injected)
    })
  )

  it.effect("guestAgentReady=false なら waitForGuestAgent は ProvisionTimeout", () =>
    Effect.gen(function* () {
      const { layer } = makeProxmoxPortTest({ guestAgentReady: false })
      const error = yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.waitForGuestAgent(1101, 1_000)),
        Effect.provide(layer),
        Effect.flip
      )
      expect(error).toBeInstanceOf(ProvisionTimeout)
    })
  )

  it.effect("getNodeFreeMemBytes は指定値(既定 6_000_000_000 bytes = 約 5.59GiB)を返す", () =>
    Effect.gen(function* () {
      const { layer } = makeProxmoxPortTest({ freeMemBytes: 1_234 })
      const free = yield* ProxmoxPort.pipe(Effect.flatMap((px) => px.getNodeFreeMemBytes), Effect.provide(layer))
      expect(free).toBe(1_234)
    })
  )
})

describe("makeCloudflarePortTest", () => {
  it.effect("ensureAccessApp は和集合になり、remove は該当ホストのみ消す", () =>
    Effect.gen(function* () {
      const { getState, layer } = makeCloudflarePortTest()
      yield* CloudflarePort.pipe(
        Effect.flatMap((cf) =>
          Effect.gen(function* () {
            yield* cf.ensureInstanceRoute({ hostname: "a.kisen.one", ip: "10.100.1.11" })
            yield* cf.ensureAccessApp({ hostname: "a.kisen.one", emails: ["x@example.com"] })
            yield* cf.ensureAccessApp({ hostname: "a.kisen.one", emails: ["x@example.com", "y@example.com"] })
          })
        ),
        Effect.provide(layer)
      )
      const state = yield* getState
      expect(state.routesByHostname).toStrictEqual({ "a.kisen.one": "10.100.1.11" })
      expect([...state.accessEmailsByHostname["a.kisen.one"]].sort()).toStrictEqual(["x@example.com", "y@example.com"])
    })
  )

  it.effect("failWith で指定した操作は常に失敗する", () =>
    Effect.gen(function* () {
      const injected = new CloudflareError({ cause: "boom" })
      const { layer } = makeCloudflarePortTest({ failWith: { ensureAccessApp: injected } })
      const error = yield* CloudflarePort.pipe(
        Effect.flatMap((cf) => cf.ensureAccessApp({ hostname: "a.kisen.one", emails: [] })),
        Effect.provide(layer),
        Effect.flip
      )
      expect(error).toBe(injected)
    })
  )
})

describe("makeGithubKeysPortTest", () => {
  it.effect("登録済み login は鍵一覧を返す", () =>
    Effect.gen(function* () {
      const layer = makeGithubKeysPortTest({ octocat: ["ssh-ed25519 AAAA test"] })
      const keys = yield* GithubKeysPort.pipe(Effect.flatMap((k) => k.fetchKeys("octocat")), Effect.provide(layer))
      expect(keys).toStrictEqual(["ssh-ed25519 AAAA test"])
    })
  )

  it.effect("未登録 / 空配列の login は GithubKeysError", () =>
    Effect.gen(function* () {
      const layer = makeGithubKeysPortTest({ empty: [] })
      const error1 = yield* GithubKeysPort.pipe(
        Effect.flatMap((k) => k.fetchKeys("nonexistent")),
        Effect.provide(layer),
        Effect.flip
      )
      const error2 = yield* GithubKeysPort.pipe(
        Effect.flatMap((k) => k.fetchKeys("empty")),
        Effect.provide(layer),
        Effect.flip
      )
      expect(error1).toBeInstanceOf(GithubKeysError)
      expect(error2).toBeInstanceOf(GithubKeysError)
    })
  )
})
