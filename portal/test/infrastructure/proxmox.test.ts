import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { it } from "@effect/vitest"
import { ConfigProvider, Effect, Either, Fiber, Layer, Option, TestClock } from "effect"
import { describe, expect } from "vitest"
import { ProvisionTimeout, ProxmoxError, ProxmoxPort } from "../../src/application/ports.js"
import { ProxmoxLive, resolveProxmoxTlsPolicy } from "../../src/infrastructure/proxmox/client.js"

// ProxmoxLive を、Proxmox VE API を模した fake HttpClient の上で検証する
// (githubOAuth.test.ts と同じパターン)。実 HTTP・実 TLS は発生しない。

const configLayer = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["PROXMOX_API_URL", "https://192.0.2.10:8006/api2/json"],
      ["PROXMOX_TOKEN_ID", "portal@pve!inucon"],
      ["PROXMOX_TOKEN_SECRET", "test-secret"]
    ])
  )
)

const jsonResponse = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  )

const bodyText = (request: HttpClientRequest.HttpClientRequest): string => {
  if (request.body._tag === "Uint8Array") return new TextDecoder().decode(request.body.body)
  return ""
}

const bodyParams = (request: HttpClientRequest.HttpClientRequest): URLSearchParams =>
  new URLSearchParams(bodyText(request))

const urlPath = (request: HttpClientRequest.HttpClientRequest): string =>
  HttpClientRequest.toUrl(request).pipe(Option.map((u) => u.pathname), Option.getOrElse(() => request.url))

interface TaskState {
  upid: string
  sequence: ReadonlyArray<{ status: string; exitstatus?: string }>
  callCount: number
}

const makeFakeProxmox = (
  overrides?: {
    tasks?: Record<string, ReadonlyArray<{ status: string; exitstatus?: string }>>
    agentPingSequence?: ReadonlyArray<"ok" | "not-ready">
    memoryFreeBytes?: number
    notFoundVmids?: ReadonlyArray<number>
  }
) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const taskStates = new Map<string, TaskState>()
  let upidCounter = 0
  const tasksSpec = overrides?.tasks ?? {}
  const agentPingSequence = overrides?.agentPingSequence ?? ["ok"]
  let agentPingCallCount = 0
  const notFoundVmids = new Set(overrides?.notFoundVmids ?? [])

  const registerTask = (key: string): string => {
    const upid = `UPID:eevee:${++upidCounter}:${key}`
    taskStates.set(upid, { upid, sequence: tasksSpec[key] ?? [{ status: "stopped", exitstatus: "OK" }], callCount: 0 })
    return upid
  }

  const client = HttpClient.make((request) => {
    requests.push(request)
    const path = urlPath(request)
    const method = request.method

    const vmidFromPath = (pattern: RegExp): number | undefined => {
      const m = path.match(pattern)
      return m ? Number(m[1]) : undefined
    }

    // clone
    const cloneMatch = path.match(/^\/api2\/json\/nodes\/eevee\/qemu\/(\d+)\/clone$/)
    if (cloneMatch && method === "POST") {
      const upid = registerTask("clone")
      return Effect.succeed(jsonResponse(request, { data: upid }))
    }

    // start
    const startMatch = path.match(/^\/api2\/json\/nodes\/eevee\/qemu\/(\d+)\/status\/start$/)
    if (startMatch && method === "POST") {
      const vmid = Number(startMatch[1])
      if (notFoundVmids.has(vmid)) {
        return Effect.succeed(jsonResponse(request, { errors: "no such VM" }, 404))
      }
      const upid = registerTask("start")
      return Effect.succeed(jsonResponse(request, { data: upid }))
    }

    // stop
    const stopMatch = path.match(/^\/api2\/json\/nodes\/eevee\/qemu\/(\d+)\/status\/stop$/)
    if (stopMatch && method === "POST") {
      const vmid = Number(stopMatch[1])
      if (notFoundVmids.has(vmid)) {
        return Effect.succeed(jsonResponse(request, { errors: "no such VM" }, 404))
      }
      const upid = registerTask("stop")
      return Effect.succeed(jsonResponse(request, { data: upid }))
    }

    // destroy
    const destroyMatch = path.match(/^\/api2\/json\/nodes\/eevee\/qemu\/(\d+)$/)
    if (destroyMatch && method === "DELETE") {
      const vmid = Number(destroyMatch[1])
      if (notFoundVmids.has(vmid)) {
        return Effect.succeed(jsonResponse(request, { errors: "no such VM" }, 404))
      }
      const upid = registerTask("destroy")
      return Effect.succeed(jsonResponse(request, { data: upid }))
    }

    // task status polling
    const taskMatch = path.match(/^\/api2\/json\/nodes\/eevee\/tasks\/(.+)\/status$/)
    if (taskMatch && method === "GET") {
      const upid = decodeURIComponent(taskMatch[1])
      const state = taskStates.get(upid)
      if (state === undefined) {
        return Effect.succeed(jsonResponse(request, { data: { status: "stopped", exitstatus: "OK" } }))
      }
      const step = state.sequence[Math.min(state.callCount, state.sequence.length - 1)]
      state.callCount++
      return Effect.succeed(jsonResponse(request, { data: step }))
    }

    // config
    const configMatch = path.match(/^\/api2\/json\/nodes\/eevee\/qemu\/(\d+)\/config$/)
    if (configMatch && method === "POST") {
      return Effect.succeed(jsonResponse(request, { data: null }))
    }

    // snippet upload
    if (path === "/api2/json/nodes/eevee/storage/local/upload" && method === "POST") {
      return Effect.succeed(jsonResponse(request, { data: null }))
    }

    // guest agent ping
    const pingMatch = path.match(/^\/api2\/json\/nodes\/eevee\/qemu\/(\d+)\/agent\/ping$/)
    if (pingMatch && method === "POST") {
      const outcome = agentPingSequence[Math.min(agentPingCallCount, agentPingSequence.length - 1)]
      agentPingCallCount++
      if (outcome === "ok") {
        return Effect.succeed(jsonResponse(request, { data: {} }))
      }
      return Effect.succeed(jsonResponse(request, { data: "QEMU guest agent is not running" }, 500))
    }

    // guest exec
    const execMatch = path.match(/^\/api2\/json\/nodes\/eevee\/qemu\/(\d+)\/agent\/exec$/)
    if (execMatch && method === "POST") {
      return Effect.succeed(jsonResponse(request, { data: { pid: 4242 } }))
    }
    const execStatusMatch = path.match(/^\/api2\/json\/nodes\/eevee\/qemu\/(\d+)\/agent\/exec-status$/)
    if (execStatusMatch && method === "GET") {
      return Effect.succeed(
        jsonResponse(request, { data: { exited: 1, exitcode: 0, "out-data": "2 authorized_keys\n" } })
      )
    }

    // node status
    if (path === "/api2/json/nodes/eevee/status" && method === "GET") {
      return Effect.succeed(
        jsonResponse(request, { data: { memory: { free: overrides?.memoryFreeBytes ?? 6_000_000_000 } } })
      )
    }

    void vmidFromPath
    return Effect.succeed(jsonResponse(request, { errors: "not found" }, 404))
  })

  return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

const portLayer = (fake: { layer: Layer.Layer<HttpClient.HttpClient> }) =>
  ProxmoxLive.pipe(Layer.provide(fake.layer), Layer.provide(configLayer))

describe("cloneVm", () => {
  it.effect("トークン認証ヘッダを付けて clone → タスク完了までポーリングする", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ tasks: { clone: [{ status: "running" }, { status: "stopped", exitstatus: "OK" }] } })
      const fiber = yield* Effect.fork(
        ProxmoxPort.pipe(
          Effect.flatMap((px) => px.cloneVm({ templateVmid: 9100, newVmid: 1101, name: "inucon-team1-1" })),
          Effect.provide(portLayer(fake))
        )
      )
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(fiber)

      const cloneReq = fake.requests.find((r) => urlPath(r).endsWith("/qemu/9100/clone"))
      expect(cloneReq).toBeDefined()
      expect(cloneReq!.headers.authorization).toBe("PVEAPIToken=portal@pve!inucon=test-secret")
      const params = bodyParams(cloneReq!)
      expect(params.get("newid")).toBe("1101")
      expect(params.get("full")).toBe("0")
      expect(params.get("name")).toBe("inucon-team1-1")

      const taskReqs = fake.requests.filter((r) => urlPath(r).includes("/tasks/"))
      expect(taskReqs.length).toBeGreaterThanOrEqual(2)
    })
  )

  it.effect("タスクが失敗(exitstatus != OK)で終わると ProxmoxError", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ tasks: { clone: [{ status: "stopped", exitstatus: "clone failed" }] } })
      const error = yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.cloneVm({ templateVmid: 9100, newVmid: 1101, name: "x" })),
        Effect.provide(portLayer(fake)),
        Effect.flip
      )
      expect(error).toBeInstanceOf(ProxmoxError)
    })
  )
})

describe("configureCloudInit", () => {
  it.effect("snippet を multipart でアップロードし、cicustom/ipconfig0 を config に設定する", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox()
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) =>
          px.configureCloudInit({
            vmid: 1101,
            ip: "10.100.1.11",
            gateway: "10.100.1.1",
            sshKeys: "ssh-ed25519 AAAA... a@b\nssh-rsa BBBB... c@d"
          })
        ),
        Effect.provide(portLayer(fake))
      )

      const uploadReq = fake.requests.find((r) => urlPath(r) === "/api2/json/nodes/eevee/storage/local/upload")
      expect(uploadReq).toBeDefined()
      expect(uploadReq!.body._tag).toBe("FormData")
      const formData = uploadReq!.body._tag === "FormData" ? uploadReq!.body.formData : undefined
      expect(formData?.get("content")).toBe("snippets")
      const filePart = formData?.get("filename") as File
      expect(filePart.name).toBe("inucon-1101.yaml")
      const yamlText = yield* Effect.promise(() => filePart.text())
      expect(yamlText).toContain("isucon")
      expect(yamlText).toContain("ssh-ed25519 AAAA... a@b")
      expect(yamlText).toContain("ssh-rsa BBBB... c@d")

      const configReq = fake.requests.find(
        (r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/1101/config" && r.method === "POST"
      )
      expect(configReq).toBeDefined()
      const params = bodyParams(configReq!)
      expect(params.get("cicustom")).toBe("user=local:snippets/inucon-1101.yaml")
      expect(params.get("ipconfig0")).toBe("gw=10.100.1.1,ip=10.100.1.11/24")
      expect(params.get("nameserver")).toBe("1.1.1.1")
    })
  )
})

describe("setVnet", () => {
  it.effect("net0 に bridge を設定する", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox()
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.setVnet({ vmid: 1101, bridge: "team1" })),
        Effect.provide(portLayer(fake))
      )
      const configReq = fake.requests.find((r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/1101/config")
      const params = bodyParams(configReq!)
      expect(params.get("net0")).toBe("virtio,bridge=team1,firewall=0")
    })
  )
})

describe("startVm / stopAndDestroyVm", () => {
  it.effect("startVm はタスク完了まで待つ", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox()
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.startVm(1101)),
        Effect.provide(portLayer(fake))
      )
      expect(fake.requests.some((r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/1101/status/start")).toBe(true)
    })
  )

  it.effect("stopAndDestroyVm は stop → delete(purge=1) の順で呼ぶ", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox()
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.stopAndDestroyVm(1101)),
        Effect.provide(portLayer(fake))
      )
      const stopReq = fake.requests.find((r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/1101/status/stop")
      const deleteReq = fake.requests.find((r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/1101" && r.method === "DELETE")
      expect(stopReq).toBeDefined()
      expect(deleteReq).toBeDefined()
      const params = HttpClientRequest.toUrl(deleteReq!).pipe(
        Option.map((u) => u.searchParams.get("purge")),
        Option.getOrElse(() => null)
      )
      expect(params).toBe("1")
      expect(fake.requests.indexOf(stopReq!)).toBeLessThan(fake.requests.indexOf(deleteReq!))
    })
  )

  it.effect("冪等: VM が既に存在しない(404)場合も成功する", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ notFoundVmids: [9999] })
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.stopAndDestroyVm(9999)),
        Effect.provide(portLayer(fake))
      )
    })
  )
})

describe("waitForGuestAgent", () => {
  it.effect("ping が成功すれば即完了", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ agentPingSequence: ["ok"] })
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.waitForGuestAgent(1101, 5_000)),
        Effect.provide(portLayer(fake))
      )
    })
  )

  it.effect("最初 not-ready → 次 ok ならリトライして成功する", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ agentPingSequence: ["not-ready", "not-ready", "ok"] })
      const fiber = yield* Effect.fork(
        ProxmoxPort.pipe(
          Effect.flatMap((px) => px.waitForGuestAgent(1101, 30_000)),
          Effect.provide(portLayer(fake))
        )
      )
      yield* TestClock.adjust("10 seconds")
      yield* TestClock.adjust("10 seconds")
      const result = yield* Fiber.join(fiber)
      expect(result).toBeUndefined()
    })
  )

  it.effect("timeoutMillis を超えると ProvisionTimeout", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ agentPingSequence: ["not-ready"] })
      const fiber = yield* Effect.fork(
        ProxmoxPort.pipe(Effect.flatMap((px) => px.waitForGuestAgent(1101, 5_000))).pipe(
          Effect.provide(portLayer(fake))
        )
      )
      yield* TestClock.adjust("10 seconds")
      const result = yield* Fiber.join(fiber).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(ProvisionTimeout)
      }
    })
  )
})

describe("guestExec", () => {
  it.effect("command を argv 分離のまま送り、exec-status をポーリングして結果を返す", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox()
      const result = yield* ProxmoxPort.pipe(
        Effect.flatMap((px) =>
          px.guestExec({
            vmid: 1101,
            command: ["/bin/sh", "-c", "echo hi"]
          })
        ),
        Effect.provide(portLayer(fake))
      )
      expect(result).toStrictEqual({ exitcode: 0, out: "2 authorized_keys\n" })

      const execReq = fake.requests.find((r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/1101/agent/exec")
      const params = bodyParams(execReq!)
      expect(params.getAll("command")).toStrictEqual(["/bin/sh", "-c", "echo hi"])
    })
  )
})

describe("getNodeFreeMemBytes", () => {
  it.effect("nodes/eevee/status の memory.free を返す", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ memoryFreeBytes: 5_726_623_744 })
      const free = yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.getNodeFreeMemBytes),
        Effect.provide(portLayer(fake))
      )
      expect(free).toBe(5_726_623_744)
    })
  )

  it.effect("HTTP エラーは ProxmoxError", () =>
    Effect.gen(function* () {
      const brokenClient = HttpClient.make((request) =>
        Effect.succeed(jsonResponse(request, { errors: "boom" }, 500))
      )
      const brokenLayer = ProxmoxLive.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, brokenClient)),
        Layer.provide(configLayer)
      )
      const error = yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.getNodeFreeMemBytes),
        Effect.provide(brokenLayer),
        Effect.flip
      )
      expect(error).toBeInstanceOf(ProxmoxError)
    })
  )
})

describe("resolveProxmoxTlsPolicy(TLS 方針の決定、純粋関数)", () => {
  it("PROXMOX_TLS_INSECURE=true なら insecure(検証スキップ)", () => {
    const policy = resolveProxmoxTlsPolicy({ insecure: true, fingerprint: Option.none() })
    expect(Either.isRight(policy) && policy.right._tag === "insecure").toBe(true)
  })

  it("PROXMOX_TLS_FINGERPRINT があれば pinned", () => {
    const policy = resolveProxmoxTlsPolicy({
      insecure: false,
      fingerprint: Option.some("AA:BB:CC")
    })
    expect(
      Either.isRight(policy) && policy.right._tag === "pinned" && policy.right.fingerprint256 === "AA:BB:CC"
    ).toBe(true)
  })

  it("どちらも未設定なら安全側に倒して失敗(fail closed)", () => {
    const policy = resolveProxmoxTlsPolicy({ insecure: false, fingerprint: Option.none() })
    expect(Either.isLeft(policy)).toBe(true)
  })

  it("insecure=true が優先される(fingerprint 併存時も insecure)", () => {
    const policy = resolveProxmoxTlsPolicy({ insecure: true, fingerprint: Option.some("AA:BB") })
    expect(Either.isRight(policy) && policy.right._tag === "insecure").toBe(true)
  })
})
