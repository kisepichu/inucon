import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { it } from "@effect/vitest"
import { ConfigProvider, Effect, Either, Exit, Fiber, Layer, Option, TestClock } from "effect"
import { describe, expect } from "vitest"
import { ModeTransitionTimeout, ProvisionTimeout, ProxmoxError, ProxmoxPort } from "../../src/application/ports.js"
import {
  ProxmoxLive,
  resolveProxmoxTlsPolicy,
  verifyFingerprintMatch,
  verifyInsecureHost
} from "../../src/infrastructure/proxmox/client.js"

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
    agentPingSequence?: ReadonlyArray<"ok" | "not-ready" | "hang" | "forbidden">
    memoryFreeBytes?: number
    notFoundVmids?: ReadonlyArray<number>
    // status/current(vmExists)を復旧不能なエラー(403 等)で応答させる vmid。
    statusCurrentErrorVmids?: ReadonlyArray<number>
    // PVE 9 実機(Task 7)で観測: 存在しない VM への status/current・stop・delete は
    // 404 ではなく 500 + {"data":null,"message":"Configuration file '...' does not exist\n"}
    // を返す。この vmid に対しては該当エンドポイントすべてでその応答を模す。
    missingConfig500Vmids?: ReadonlyArray<number>
    // 「does not exist」を含まない、本当の 500(復旧不能)を模す vmid。
    genericServerError500Vmids?: ReadonlyArray<number>
    // 「does not exist」は含むが、VM の設定ファイル欠落とは無関係な 500(例:
    // ストレージ側のエラー)を模す vmid。qemu-server 設定ファイル欠落の
    // メッセージにのみマッチさせる回帰テスト用(codex P1)。
    unrelatedDoesNotExistVmids?: ReadonlyArray<number>
  }
) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const taskStates = new Map<string, TaskState>()
  let upidCounter = 0
  const tasksSpec = overrides?.tasks ?? {}
  const agentPingSequence = overrides?.agentPingSequence ?? ["ok"]
  let agentPingCallCount = 0
  const notFoundVmids = new Set(overrides?.notFoundVmids ?? [])
  const statusCurrentErrorVmids = new Set(overrides?.statusCurrentErrorVmids ?? [])
  const missingConfig500Vmids = new Set(overrides?.missingConfig500Vmids ?? [])
  const genericServerError500Vmids = new Set(overrides?.genericServerError500Vmids ?? [])
  const unrelatedDoesNotExistVmids = new Set(overrides?.unrelatedDoesNotExistVmids ?? [])
  const missingConfigResponse = (request: HttpClientRequest.HttpClientRequest, vmid: number) =>
    jsonResponse(
      request,
      { data: null, message: `Configuration file 'nodes/eevee/qemu-server/${vmid}.conf' does not exist\n` },
      500
    )
  const genericErrorResponse = (request: HttpClientRequest.HttpClientRequest) =>
    jsonResponse(request, { data: null, message: "internal error" }, 500)
  const unrelatedDoesNotExistResponse = (request: HttpClientRequest.HttpClientRequest) =>
    jsonResponse(request, { data: null, message: "storage 'local' does not exist\n" }, 500)

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

    // shutdown (Task 8)
    const shutdownMatch = path.match(/^\/api2\/json\/nodes\/eevee\/qemu\/(\d+)\/status\/shutdown$/)
    if (shutdownMatch && method === "POST") {
      const upid = registerTask("shutdown")
      return Effect.succeed(jsonResponse(request, { data: upid }))
    }

    // stop
    const stopMatch = path.match(/^\/api2\/json\/nodes\/eevee\/qemu\/(\d+)\/status\/stop$/)
    if (stopMatch && method === "POST") {
      const vmid = Number(stopMatch[1])
      if (missingConfig500Vmids.has(vmid)) {
        return Effect.succeed(missingConfigResponse(request, vmid))
      }
      if (unrelatedDoesNotExistVmids.has(vmid)) {
        return Effect.succeed(unrelatedDoesNotExistResponse(request))
      }
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
      if (missingConfig500Vmids.has(vmid)) {
        return Effect.succeed(missingConfigResponse(request, vmid))
      }
      if (unrelatedDoesNotExistVmids.has(vmid)) {
        return Effect.succeed(unrelatedDoesNotExistResponse(request))
      }
      if (notFoundVmids.has(vmid)) {
        return Effect.succeed(jsonResponse(request, { errors: "no such VM" }, 404))
      }
      const upid = registerTask("destroy")
      return Effect.succeed(jsonResponse(request, { data: upid }))
    }

    // status/current(vmExists)
    const statusCurrentMatch = path.match(/^\/api2\/json\/nodes\/eevee\/qemu\/(\d+)\/status\/current$/)
    if (statusCurrentMatch && method === "GET") {
      const vmid = Number(statusCurrentMatch[1])
      if (statusCurrentErrorVmids.has(vmid)) {
        return Effect.succeed(jsonResponse(request, { errors: "forbidden" }, 403))
      }
      if (genericServerError500Vmids.has(vmid)) {
        return Effect.succeed(genericErrorResponse(request))
      }
      if (missingConfig500Vmids.has(vmid)) {
        return Effect.succeed(missingConfigResponse(request, vmid))
      }
      if (unrelatedDoesNotExistVmids.has(vmid)) {
        return Effect.succeed(unrelatedDoesNotExistResponse(request))
      }
      if (notFoundVmids.has(vmid)) {
        return Effect.succeed(jsonResponse(request, { errors: "no such VM" }, 404))
      }
      return Effect.succeed(jsonResponse(request, { data: { status: "running" } }))
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

    // guest agent ping
    const pingMatch = path.match(/^\/api2\/json\/nodes\/eevee\/qemu\/(\d+)\/agent\/ping$/)
    if (pingMatch && method === "POST") {
      const outcome = agentPingSequence[Math.min(agentPingCallCount, agentPingSequence.length - 1)]
      agentPingCallCount++
      if (outcome === "hang") {
        // 単発の HTTP 呼び出しがハングする状況を模する(pollUntil の個々の
        // attempt timeout が無ければ、これだけで永遠に先へ進めなくなる)。
        return Effect.sleep("20 seconds").pipe(
          Effect.andThen(Effect.succeed(jsonResponse(request, { data: "still not ready" }, 500)))
        )
      }
      if (outcome === "ok") {
        return Effect.succeed(jsonResponse(request, { data: {} }))
      }
      if (outcome === "forbidden") {
        // トークン不正等、復旧不能なケース(pollUntil の deadline を待たず即 fail すべき)。
        return Effect.succeed(jsonResponse(request, { errors: "invalid token" }, 403))
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
  // PVE 9.2 実機(Task 7)では snippets の upload API 自体が
  // 400 Parameter verification failed: content 'snippets' does not have a value
  // in the enumeration 'iso, vztmpl, import' で拒否される(snippets は upload
  // 不可)。そのため cicustom + snippet アップロードはやめ、PVE ネイティブの
  // ciuser/sshkeys パラメータだけを 1 回の config 更新で設定する。
  it.effect("upload は行わず、config に ciuser/sshkeys/ipconfig0 を 1 リクエストで設定する", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox()
      // 鍵にスペースと '+' を含めて、sshkeys の値が(transport の form-decode を
      // 一段挟んだ後もなお)encodeURIComponent 済みの形で保持されることを確認する。
      const keyWithSpecialChars = "ssh-ed25519 AAAA+abc user@host"
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) =>
          px.configureCloudInit({
            vmid: 1101,
            ip: "10.100.1.11",
            gateway: "10.100.1.1",
            sshKeys: `ssh-ed25519 AAAA... a@b\n${keyWithSpecialChars}`
          })
        ),
        Effect.provide(portLayer(fake))
      )

      // snippet upload リクエストは一切送らない。
      const uploadReq = fake.requests.find((r) => urlPath(r) === "/api2/json/nodes/eevee/storage/local/upload")
      expect(uploadReq).toBeUndefined()

      // config 更新は 1 回だけ。
      const configReqs = fake.requests.filter(
        (r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/1101/config" && r.method === "POST"
      )
      expect(configReqs.length).toBe(1)

      const params = bodyParams(configReqs[0])
      expect(params.get("ciuser")).toBe("isucon")
      // params.get() は transport(bodyUrlParams)の form-decode を 1 段行う。
      // 実装は sshkeys の値そのものを encodeURIComponent しているので、
      // ここで得られる値はなお percent-encode されたままであるはず(PVE
      // 自身がこの形で config に保存する既知の慣習。bpg/proxmox provider と同じ)。
      const expectedSshkeys = encodeURIComponent(`ssh-ed25519 AAAA... a@b\n${keyWithSpecialChars}`)
      expect(params.get("sshkeys")).toBe(expectedSshkeys)
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

  // PVE 9 実機(Task 7)で観測: 既に消えている VM への stop/delete は 404 ではなく
  // 500 + "Configuration file '...' does not exist" を返す。テアダウンは冪等
  // 操作なので、この応答も「既に無い」= 成功として扱わなければならない。
  it.effect("冪等: VM が既に存在しない(500 + does not exist)場合も成功する(Task 7 実機検出)", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ missingConfig500Vmids: [1102] })
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.stopAndDestroyVm(1102)),
        Effect.provide(portLayer(fake))
      )
    })
  )

  // codex レビュー P1: 「does not exist」を含む非 2xx を無差別に「VM 不在」扱いすると、
  // stop/delete 中に起きた無関係なエラー(例: storage 'local' does not exist)まで
  // 「既に消えている」と誤認し、インスタンスを deleted にしてしまう(VM 実体は残った
  // まま orphan 化する)。qemu-server 設定ファイル欠落メッセージ以外は復旧不能な
  // ProxmoxError として fail しなければならない。
  it.effect("無関係な 500(storage 'local' does not exist 等)は不在扱いにせず ProxmoxError で fail する(codex P1)", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ unrelatedDoesNotExistVmids: [1103] })
      const exit = yield* Effect.exit(
        ProxmoxPort.pipe(
          Effect.flatMap((px) => px.stopAndDestroyVm(1103)),
          Effect.provide(portLayer(fake))
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })
  )

  // PVE 9 実機(Task 7 再検証)で観測: 存在しない VM への stop は 200 + UPID を
  // 返し(同期エラーにならない)、そのタスクを poll すると
  // exitstatus="unable to find configuration file for VM <vmid>" で stopped する。
  // vmExists による事前短絡が効けば、そもそも stop/destroy は一切呼ばれない。
  it.effect("冪等: vmExists が false(VM 不在)なら stop/destroy を呼ばずに成功する(Task 7 再検証)", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ missingConfig500Vmids: [1102] })
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.stopAndDestroyVm(1102)),
        Effect.provide(portLayer(fake))
      )
      const stopReq = fake.requests.find((r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/1102/status/stop")
      const deleteReq = fake.requests.find(
        (r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/1102" && r.method === "DELETE"
      )
      expect(stopReq).toBeUndefined()
      expect(deleteReq).toBeUndefined()
    })
  )

  // PVE 9 実機(Task 7 再検証)で観測: VM は存在する(vmExists=true)が、stop の
  // UPID を poll すると exitstatus="unable to find configuration file for VM 1102"
  // で stopped する非同期の VM 不在ケース(競合等)。これはタスクレベルの失敗だが
  // 「既に無い」ことを意味するので、テアダウンは成功として扱わなければならない。
  it.effect("冪等: stop タスクが 'unable to find configuration file for VM <vmid>' exitstatus で失敗しても成功する(Task 7 再検証)", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({
        tasks: { stop: [{ status: "stopped", exitstatus: "unable to find configuration file for VM 1102" }] }
      })
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.stopAndDestroyVm(1102)),
        Effect.provide(portLayer(fake))
      )
    })
  )

  it.effect("冪等: destroy タスクが 'unable to find configuration file for VM <vmid>' exitstatus で失敗しても成功する(Task 7 再検証)", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({
        tasks: { destroy: [{ status: "stopped", exitstatus: "unable to find configuration file for VM 1102" }] }
      })
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.stopAndDestroyVm(1102)),
        Effect.provide(portLayer(fake))
      )
    })
  )

  // 無関係な task 失敗(VM 不在パターンにマッチしない)まで飲み込んではいけない
  // (テアダウンが実際には失敗しているのに成功扱いになると orphan 化する)。
  it.effect("stop タスクが無関係な exitstatus で失敗した場合は ProxmoxError で fail する(飲み込まない)", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({
        tasks: { stop: [{ status: "stopped", exitstatus: "some other error" }] }
      })
      const exit = yield* Effect.exit(
        ProxmoxPort.pipe(
          Effect.flatMap((px) => px.stopAndDestroyVm(1102)),
          Effect.provide(portLayer(fake))
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })
  )

  it.effect("destroy タスクが無関係な exitstatus で失敗した場合は ProxmoxError で fail する(飲み込まない)", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({
        tasks: { destroy: [{ status: "stopped", exitstatus: "some other error" }] }
      })
      const exit = yield* Effect.exit(
        ProxmoxPort.pipe(
          Effect.flatMap((px) => px.stopAndDestroyVm(1102)),
          Effect.provide(portLayer(fake))
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })
  )
})

describe("vmExists(clone 再入可能性チェック、Task 4 レビュー C1)", () => {
  it.effect("status/current が 200 なら true", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox()
      const exists = yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.vmExists(1101)),
        Effect.provide(portLayer(fake))
      )
      expect(exists).toBe(true)
      expect(fake.requests.some((r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/1101/status/current")).toBe(true)
    })
  )

  it.effect("status/current が 404 なら false", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ notFoundVmids: [1101] })
      const exists = yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.vmExists(1101)),
        Effect.provide(portLayer(fake))
      )
      expect(exists).toBe(false)
    })
  )

  it.effect("404/2xx 以外(例: 403)は復旧不能な ProxmoxError", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ statusCurrentErrorVmids: [1101] })
      const exit = yield* Effect.exit(
        ProxmoxPort.pipe(
          Effect.flatMap((px) => px.vmExists(1101)),
          Effect.provide(portLayer(fake))
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })
  )

  // PVE 9 実機(Task 7)で観測: 存在しない VM への status/current は 404 ではなく
  // 500 + {"data":null,"message":"Configuration file '...' does not exist\n"} を返す。
  // 404 決め打ちだと fatal ProxmoxError になり払い出しが即失敗していた実バグ。
  it.effect("status/current が 500 + does not exist なら false(Task 7 実機検出)", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ missingConfig500Vmids: [1102] })
      const exists = yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.vmExists(1102)),
        Effect.provide(portLayer(fake))
      )
      expect(exists).toBe(false)
    })
  )

  it.effect("status/current が 500 だが does not exist を含まない場合は ProxmoxError(本当のエラーを飲み込まない)", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ genericServerError500Vmids: [1102] })
      const exit = yield* Effect.exit(
        ProxmoxPort.pipe(
          Effect.flatMap((px) => px.vmExists(1102)),
          Effect.provide(portLayer(fake))
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })
  )

  // codex レビュー P1: 「does not exist」を含む文字列全般を不在扱いにすると、
  // storage 'local' does not exist のような無関係なエラーまで「VM 不在」と
  // 誤認し、vmExists が false を返して二重 clone を招く。qemu-server 設定
  // ファイル欠落メッセージ以外は復旧不能な ProxmoxError として fail する。
  it.effect("status/current が 500 + 無関係な does not exist(例: storage)なら ProxmoxError(codex P1)", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ unrelatedDoesNotExistVmids: [1103] })
      const exit = yield* Effect.exit(
        ProxmoxPort.pipe(
          Effect.flatMap((px) => px.vmExists(1103)),
          Effect.provide(portLayer(fake))
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
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

  it.effect("500(guest agent not running)が返る間はリトライし、最終的に 200 で ready になる", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ agentPingSequence: ["not-ready", "not-ready", "not-ready", "ok"] })
      const fiber = yield* Effect.fork(
        ProxmoxPort.pipe(
          Effect.flatMap((px) => px.waitForGuestAgent(1101, 30_000)),
          Effect.provide(portLayer(fake))
        )
      )
      yield* TestClock.adjust("2 seconds")
      yield* TestClock.adjust("2 seconds")
      yield* TestClock.adjust("2 seconds")
      const result = yield* Fiber.join(fiber)
      expect(result).toBeUndefined()
    })
  )

  it.effect("403(トークン不正)が返ると即 ProxmoxError で fail する(タイムアウトを待たない)", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox({ agentPingSequence: ["forbidden"] })
      const fiber = yield* Effect.fork(
        ProxmoxPort.pipe(
          Effect.flatMap((px) => px.waitForGuestAgent(1101, 60_000)),
          Effect.provide(portLayer(fake))
        )
      )
      // deadline(60 秒)まで進めなくても、最初の attempt だけで即 fail するはず。
      yield* TestClock.adjust("1 second")
      const result = yield* Fiber.join(fiber).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(ProxmoxError)
      }
    })
  )

  it.effect("単発の HTTP 呼び出しがハングしても attempt timeout で次のラウンドへ進み、全体タイムアウトで ProvisionTimeout になる", () =>
    Effect.gen(function* () {
      // ping が毎回ハング(20 秒)する。pollUntil に個々の attempt timeout(既定 10 秒)が
      // 無ければ、最初の attempt がハングしたまま全体の 15 秒デッドライン判定に
      // 一度も到達できず、テストの TestClock.adjust だけでは完了しない。
      const fake = makeFakeProxmox({ agentPingSequence: ["hang", "hang", "hang", "hang"] })
      const fiber = yield* Effect.fork(
        ProxmoxPort.pipe(
          Effect.flatMap((px) => px.waitForGuestAgent(1101, 15_000)),
          Effect.provide(portLayer(fake))
        )
      )
      yield* TestClock.adjust("40 seconds")
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

// Task 7: reconciliation 向けの inventory メソッド。qemu 一覧を叩いて
// name が `^inucon-team[0-9]+-[0-9]+$` に一致する VM のみ返す(catch-all や
// devvm/benchvm 等は絶対に混ぜない)。
describe("listManagedVms", () => {
  const inventoryClient = (vms: ReadonlyArray<{
    vmid: number
    name: string
    status: "running" | "stopped"
    mem?: number
  }>) =>
    HttpClient.make((request) => {
      if (urlPath(request) === "/api2/json/nodes/eevee/qemu" && request.method === "GET") {
        return Effect.succeed(
          jsonResponse(request, {
            data: vms.map((v) => ({
              vmid: v.vmid,
              name: v.name,
              status: v.status,
              maxmem: v.mem ?? 4 * 1024 * 1024 * 1024
            }))
          })
        )
      }
      return Effect.succeed(jsonResponse(request, { errors: "not found" }, 404))
    })

  it.effect("`^inucon-team[0-9]+-[0-9]+$` に完全一致する VM のみを返す", () =>
    Effect.gen(function* () {
      const client = inventoryClient([
        { vmid: 1101, name: "inucon-team1-1", status: "running" },
        { vmid: 1102, name: "inucon-team1-2", status: "stopped" },
        { vmid: 2201, name: "inucon-team2-1", status: "running" },
        // 除外対象:
        { vmid: 9100, name: "inucon-template", status: "stopped" },
        { vmid: 9300, name: "devvm", status: "running" },
        { vmid: 9200, name: "benchvm", status: "stopped" },
        { vmid: 3000, name: "inucon-team1-1-clone", status: "stopped" },
        { vmid: 3001, name: "team1-1", status: "running" }
      ])
      const layer = ProxmoxLive.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(configLayer)
      )
      const vms = yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.listManagedVms),
        Effect.provide(layer)
      )
      expect(vms.map((v) => v.name).sort()).toStrictEqual([
        "inucon-team1-1",
        "inucon-team1-2",
        "inucon-team2-1"
      ])
      expect(vms.find((v) => v.name === "inucon-team1-1")).toMatchObject({
        vmid: 1101,
        status: "running"
      })
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
        Effect.flatMap((px) => px.listManagedVms),
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

  it("PROXMOX_TLS_FINGERPRINT があれば pinned(コロンを除去して正規化する)", () => {
    const policy = resolveProxmoxTlsPolicy({
      insecure: false,
      fingerprint: Option.some("AA:BB:CC")
    })
    expect(
      Either.isRight(policy) && policy.right._tag === "pinned" && policy.right.fingerprint256 === "AABBCC"
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

// pinned 分岐は rejectUnauthorized: false + checkServerIdentity でフィンガープリント
// 一致を必須にする(自己署名証明書のピン留めの標準パターン)。実 TLS ハンドシェイクを
// 起こさずに、checkServerIdentity 相当の比較ロジックだけを純粋関数としてテストする。
describe("verifyFingerprintMatch(checkServerIdentity 相当、純粋関数)", () => {
  it("フィンガープリントが一致すれば undefined(Node の checkServerIdentity の OK 規約)", () => {
    // expectedFingerprint256 は resolveProxmoxTlsPolicy が既に正規化した(コロン除去済み)値、
    // actualFingerprint256 は cert.fingerprint256 の生の形("AA:BB:CC" 形式)を想定。
    const result = verifyFingerprintMatch("AABBCC", "AA:BB:CC")
    expect(result).toBeUndefined()
  })

  it("大文字小文字を正規化して比較する", () => {
    const result = verifyFingerprintMatch("AABBCC", "aa:bb:cc")
    expect(result).toBeUndefined()
  })

  it("フィンガープリントが不一致なら Error(ハンドシェイク拒否)", () => {
    const result = verifyFingerprintMatch("AABBCC", "AA:BB:DD")
    expect(result).toBeInstanceOf(Error)
  })

  it("証明書に fingerprint256 が無い(undefined)場合も不一致として Error", () => {
    const result = verifyFingerprintMatch("AABBCC", undefined)
    expect(result).toBeInstanceOf(Error)
  })
})

// insecure(PROXMOX_TLS_INSECURE=true)分岐は rejectUnauthorized: false が
// https.Agent 全体に効くため、誤って Proxmox 以外の通信にこの Layer が provide
// された場合の被害を限定するホスト限定チェック(純粋関数)。
describe("verifyInsecureHost(insecure 分岐のホスト限定、純粋関数)", () => {
  it("接続先が PROXMOX_API_URL のホストと一致すれば undefined", () => {
    const result = verifyInsecureHost("192.0.2.10", "192.0.2.10")
    expect(result).toBeUndefined()
  })

  it("接続先が異なるホストなら Error(ハンドシェイク拒否)", () => {
    const result = verifyInsecureHost("192.0.2.10", "evil.example.com")
    expect(result).toBeInstanceOf(Error)
  })

  it("ホスト名の大小差は許容する(case-insensitive)", () => {
    expect(verifyInsecureHost("Eevee.Kisen.One", "eevee.kisen.one")).toBeUndefined()
  })
})

// Task 8: split provision/mode credentials + infrastructure inventory +
// mode power primitives。

const splitConfigLayer = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["PROXMOX_API_URL", "https://192.0.2.10:8006/api2/json"],
      ["PROXMOX_PROVISION_TOKEN_ID", "inucon-provision@pve!portal-1"],
      ["PROXMOX_PROVISION_TOKEN_SECRET", "provision-secret"],
      ["PROXMOX_MODE_TOKEN_ID", "inucon-mode@pve!portal-1"],
      ["PROXMOX_MODE_TOKEN_SECRET", "mode-secret"]
    ])
  )
)

describe("Proxmox credential configuration (Task 8)", () => {
  it.effect("四つの split fields が揃っていれば Layer 構築成功", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox()
      const port = ProxmoxLive.pipe(Layer.provide(fake.layer), Layer.provide(splitConfigLayer))
      // 何らかの実 API を叩いて Layer が起動できることだけ確認する。
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.getNodeFreeMemBytes),
        Effect.provide(port)
      )
    })
  )

  it.effect("split 四つのうち一部だけ設定されている場合は Layer 構築が失敗する(部分設定禁止)", () =>
    Effect.gen(function* () {
      const partialLayer = Layer.setConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ["PROXMOX_API_URL", "https://192.0.2.10:8006/api2/json"],
            ["PROXMOX_PROVISION_TOKEN_ID", "inucon-provision@pve!portal-1"],
            // PROXMOX_PROVISION_TOKEN_SECRET を欠落させる
            ["PROXMOX_MODE_TOKEN_ID", "inucon-mode@pve!portal-1"],
            ["PROXMOX_MODE_TOKEN_SECRET", "mode-secret"]
          ])
        )
      )
      const fake = makeFakeProxmox()
      const port = ProxmoxLive.pipe(Layer.provide(fake.layer), Layer.provide(partialLayer))
      const exit = yield* Effect.exit(
        ProxmoxPort.pipe(
          Effect.flatMap((px) => px.getNodeFreeMemBytes),
          Effect.provide(port)
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })
  )

  it.effect("四つの split がすべて未設定なら legacy PROXMOX_TOKEN_ID/SECRET を両クライアントで受け入れる(rolling migration)", () =>
    Effect.gen(function* () {
      const legacyLayer = Layer.setConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ["PROXMOX_API_URL", "https://192.0.2.10:8006/api2/json"],
            ["PROXMOX_TOKEN_ID", "portal@pve!inucon"],
            ["PROXMOX_TOKEN_SECRET", "legacy-secret"]
          ])
        )
      )
      const fake = makeFakeProxmox()
      const port = ProxmoxLive.pipe(Layer.provide(fake.layer), Layer.provide(legacyLayer))
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.getNodeFreeMemBytes),
        Effect.provide(port)
      )
      // node status リクエストの Authorization ヘッダは legacy tuple を使う。
      const req = fake.requests.find((r) => urlPath(r) === "/api2/json/nodes/eevee/status")
      expect(req!.headers.authorization).toBe("PVEAPIToken=portal@pve!inucon=legacy-secret")
    })
  )

  it.effect("split と legacy が同居していたら split を採用する(migration 途中の安全側)", () =>
    Effect.gen(function* () {
      const bothLayer = Layer.setConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ["PROXMOX_API_URL", "https://192.0.2.10:8006/api2/json"],
            ["PROXMOX_PROVISION_TOKEN_ID", "inucon-provision@pve!portal-1"],
            ["PROXMOX_PROVISION_TOKEN_SECRET", "provision-secret"],
            ["PROXMOX_MODE_TOKEN_ID", "inucon-mode@pve!portal-1"],
            ["PROXMOX_MODE_TOKEN_SECRET", "mode-secret"],
            ["PROXMOX_TOKEN_ID", "portal@pve!inucon"],
            ["PROXMOX_TOKEN_SECRET", "legacy-secret"]
          ])
        )
      )
      const fake = makeFakeProxmox()
      const port = ProxmoxLive.pipe(Layer.provide(fake.layer), Layer.provide(bothLayer))
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.cloneVm({ templateVmid: 9100, newVmid: 1101, name: "inucon-team1-1" })),
        Effect.provide(port)
      )
      const cloneReq = fake.requests.find((r) => urlPath(r).endsWith("/qemu/9100/clone"))
      // provision 系(cloneVm)は provision credential を使う。
      expect(cloneReq!.headers.authorization).toBe(
        "PVEAPIToken=inucon-provision@pve!portal-1=provision-secret"
      )
    })
  )

  it.effect("mode primitive(shutdownVm/setVmOnBoot 等)は mode credential を使い、provision credential は使わない", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox()
      const port = ProxmoxLive.pipe(Layer.provide(fake.layer), Layer.provide(splitConfigLayer))
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.setVmOnBoot(9200, true)),
        Effect.provide(port)
      )
      const configReq = fake.requests.find(
        (r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/9200/config" && r.method === "POST"
      )
      expect(configReq!.headers.authorization).toBe(
        "PVEAPIToken=inucon-mode@pve!portal-1=mode-secret"
      )
    })
  )
})

// setVmOnBoot: /nodes/eevee/qemu/:vmid/config を POST し、onboot パラメータを書く。
describe("setVmOnBoot", () => {
  it.effect("enabled=true なら onboot=1 を POST する", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox()
      const port = ProxmoxLive.pipe(Layer.provide(fake.layer), Layer.provide(configLayer))
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.setVmOnBoot(9200, true)),
        Effect.provide(port)
      )
      const req = fake.requests.find(
        (r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/9200/config" && r.method === "POST"
      )
      const params = bodyParams(req!)
      expect(params.get("onboot")).toBe("1")
    })
  )

  it.effect("enabled=false なら onboot=0 を POST する", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox()
      const port = ProxmoxLive.pipe(Layer.provide(fake.layer), Layer.provide(configLayer))
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.setVmOnBoot(9300, false)),
        Effect.provide(port)
      )
      const req = fake.requests.find(
        (r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/9300/config" && r.method === "POST"
      )
      expect(bodyParams(req!).get("onboot")).toBe("0")
    })
  )
})

// shutdownVm: /nodes/eevee/qemu/:vmid/status/shutdown を POST。force stop は絶対に呼ばない。
describe("shutdownVm", () => {
  it.effect("guest shutdown を POST し、force stop は呼ばない", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox()
      const port = ProxmoxLive.pipe(Layer.provide(fake.layer), Layer.provide(configLayer))
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.shutdownVm(9300)),
        Effect.provide(port)
      )
      const shutdownReq = fake.requests.find(
        (r) => urlPath(r) === "/api2/json/nodes/eevee/qemu/9300/status/shutdown" && r.method === "POST"
      )
      expect(shutdownReq).toBeDefined()
      const stopReq = fake.requests.find((r) => urlPath(r).endsWith("/status/stop"))
      expect(stopReq).toBeUndefined()
    })
  )
})

// waitForVmStatus: TestClock で status/current が期待値に達するまで poll し、
// timeout に達したら ModeTransitionTimeout。
describe("waitForVmStatus", () => {
  it.effect("status が期待値に到達すれば成功", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox()
      const port = ProxmoxLive.pipe(Layer.provide(fake.layer), Layer.provide(configLayer))
      // 現状 fake の status/current は 'running' を返す
      yield* ProxmoxPort.pipe(
        Effect.flatMap((px) => px.waitForVmStatus(9300, "running", 5_000)),
        Effect.provide(port)
      )
    })
  )

  it.effect("timeoutMillis を超えると ModeTransitionTimeout", () =>
    Effect.gen(function* () {
      const fake = makeFakeProxmox() // status/current always 'running'
      const port = ProxmoxLive.pipe(Layer.provide(fake.layer), Layer.provide(configLayer))
      const fiber = yield* Effect.fork(
        ProxmoxPort.pipe(
          Effect.flatMap((px) => px.waitForVmStatus(9300, "stopped", 5_000)),
          Effect.provide(port)
        )
      )
      yield* TestClock.adjust("10 seconds")
      const result = yield* Fiber.join(fiber).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(ModeTransitionTimeout)
      }
    })
  )
})

// getInfrastructureInventory: 単一呼び出しで template/devvm/benchvm/team slots/isolation/memory を返す。
describe("getInfrastructureInventory", () => {
  interface InventoryVm {
    vmid: number
    name: string
    status: "running" | "stopped"
    mem?: number
    onBoot?: 0 | 1
  }

  const MODE_AUTH = "PVEAPIToken=inucon-mode@pve!portal-1=mode-secret"

  const inventoryClient = (opts: {
    // mode token の qemu 一覧に見える VM(実機では /vms/9200 と /vms/9300 のみ)。
    vms: ReadonlyArray<InventoryVm>
    // provision token の qemu 一覧に見える VM。未指定なら mode 側と同じ
    // (legacy 単一 credential 構成の挙動)。
    provisionVms?: ReadonlyArray<InventoryVm>
    networks: ReadonlyArray<{ iface: string }>
    sdnVnets?: ReadonlyArray<{ vnet: string; zone?: string }>
    benchvmBridges: ReadonlyArray<string>
    // "active"/"inactive" は 2xx 応答。数値はその HTTP status をそのまま返す
    // (PVE 9.2.3 はカスタム unit 名に 400 を返す)。
    isolationStatus: "active" | "inactive" | number
    memoryFreeBytes?: number
  }) =>
    HttpClient.make((request) => {
      const path = urlPath(request)
      if (path === "/api2/json/nodes/eevee/status" && request.method === "GET") {
        return Effect.succeed(
          jsonResponse(request, {
            data: { memory: { free: opts.memoryFreeBytes ?? 20_000_000_000 } }
          })
        )
      }
      if (path === "/api2/json/nodes/eevee/qemu" && request.method === "GET") {
        // PVE は qemu 一覧を ACL でフィルタする。credential ごとに別の一覧を返す。
        const visible = request.headers.authorization === MODE_AUTH
          ? opts.vms
          : opts.provisionVms ?? opts.vms
        return Effect.succeed(
          jsonResponse(request, {
            data: visible.map((v) => ({
              vmid: v.vmid,
              name: v.name,
              status: v.status,
              maxmem: v.mem ?? 4 * 1024 * 1024 * 1024,
              onboot: v.onBoot ?? 0,
              // Task 8: template VM は Proxmox 側 template=1 で返る。テストは
              // 名前に "template" を含むかで template=1 を返し、それ以外は 0。
              template: v.name.includes("template") ? 1 : 0
            }))
          })
        )
      }
      if (path === "/api2/json/nodes/eevee/network" && request.method === "GET") {
        return Effect.succeed(
          jsonResponse(request, { data: opts.networks.map((n) => ({ iface: n.iface, type: "bridge" })) })
        )
      }
      if (path === "/api2/json/cluster/sdn/vnets" && request.method === "GET") {
        return Effect.succeed(
          jsonResponse(request, {
            data: (opts.sdnVnets ?? []).map((v) => ({ vnet: v.vnet, zone: v.zone ?? "inucon", type: "vnet" }))
          })
        )
      }
      // benchvm config
      if (
        path === "/api2/json/nodes/eevee/qemu/9200/config" &&
        request.method === "GET"
      ) {
        const cfg: Record<string, unknown> = { name: "benchvm" }
        opts.benchvmBridges.forEach((br, i) => {
          cfg[`net${i}`] = `virtio,bridge=${br},firewall=0`
        })
        return Effect.succeed(jsonResponse(request, { data: cfg }))
      }
      // isolation service
      if (
        path === "/api2/json/nodes/eevee/services/inucon-team-isolation/state" &&
        request.method === "GET"
      ) {
        if (typeof opts.isolationStatus === "number") {
          return Effect.succeed(
            jsonResponse(
              request,
              {
                errors: {
                  service:
                    "value 'inucon-team-isolation' does not have a value in the enumeration " +
                    "'chrony, corosync, cron, ksmtuned, lxcfs, postfix, proxmox-firewall, pve-cluster'"
                }
              },
              opts.isolationStatus
            )
          )
        }
        return Effect.succeed(
          jsonResponse(request, { data: { state: opts.isolationStatus === "active" ? "running" : "inactive" } })
        )
      }
      return Effect.succeed(jsonResponse(request, { errors: "not found" }, 404))
    })

  const inventoryOf = (client: HttpClient.HttpClient) =>
    ProxmoxPort.pipe(
      Effect.flatMap((px) => px.getInfrastructureInventory),
      Effect.provide(
        ProxmoxLive.pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          Layer.provide(splitConfigLayer)
        )
      )
    )

  it.effect("template + devvm + benchvm + team slots + isolation + memory を単発 inventory で返す", () =>
    Effect.gen(function* () {
      const client = inventoryClient({
        vms: [
          { vmid: 9100, name: "inucon-template", status: "stopped", mem: 2 * 1024 * 1024 * 1024 },
          { vmid: 9300, name: "devvm", status: "running", mem: 8 * 1024 * 1024 * 1024, onBoot: 1 },
          { vmid: 9200, name: "benchvm", status: "stopped", mem: 4 * 1024 * 1024 * 1024, onBoot: 0 }
        ],
        networks: [{ iface: "team1" }, { iface: "team2" }, { iface: "vmbr0" }],
        benchvmBridges: ["team1", "team2", "vmbr0"],
        isolationStatus: "active",
        memoryFreeBytes: 6_000_000_000
      })
      const inv = yield* inventoryOf(client)
      expect(inv.templateExists).toEqual(Option.some(true))
      expect(Option.getOrThrow(inv.devvm)).toMatchObject({ vmid: 9300, status: "running", onBoot: true })
      expect(Option.getOrThrow(inv.benchvm)).toMatchObject({ vmid: 9200, status: "stopped", onBoot: false })
      expect([...Option.getOrThrow(inv.preparedTeamNumbers)].sort()).toEqual([1, 2])
      expect(inv.isolationServiceActive).toEqual(Option.some(true))
      expect(inv.nodeFreeMemBytes).toEqual(Option.some(6_000_000_000))
    })
  )

  it.effect("preparedTeamNumbers は 'node 側の teamN' と 'benchvm config bridges' の積集合", () =>
    Effect.gen(function* () {
      const client = inventoryClient({
        vms: [
          { vmid: 9100, name: "inucon-template", status: "stopped" },
          { vmid: 9300, name: "devvm", status: "running" },
          { vmid: 9200, name: "benchvm", status: "stopped" }
        ],
        networks: [{ iface: "team1" }, { iface: "team2" }, { iface: "team3" }],
        // benchvm 側は team1/team2 だけ持つ → team3 は使えない
        benchvmBridges: ["team1", "team2"],
        isolationStatus: "active"
      })
      const inv = yield* inventoryOf(client)
      expect([...Option.getOrThrow(inv.preparedTeamNumbers)].sort()).toEqual([1, 2])
    })
  )

  // D2 回帰: eevee の team1/team2 は SDN vnet なので /nodes/:node/network には
  // 出ない(実測: nic0/nic1/nic2/vmbr0/wlp4s0 のみ)。/cluster/sdn/vnets を
  // 見ないと team_slots が常に fail する。
  it.effect("team bridge が SDN vnet にしか無くても preparedTeamNumbers に入る", () =>
    Effect.gen(function* () {
      const client = inventoryClient({
        vms: [
          { vmid: 9300, name: "devvm", status: "running" },
          { vmid: 9200, name: "benchvm", status: "stopped" }
        ],
        // classic bridge 側には team が 1 件も無い(実機と同じ)
        networks: [{ iface: "vmbr0" }, { iface: "nic0" }],
        sdnVnets: [{ vnet: "team1" }, { vnet: "team2" }],
        benchvmBridges: ["team1", "team2"],
        isolationStatus: "active"
      })
      const inv = yield* inventoryOf(client)
      expect([...Option.getOrThrow(inv.preparedTeamNumbers)].sort()).toEqual([1, 2])
    })
  )

  it.effect("SDN vnet 側に team3 があっても benchvm config に無ければ intersection から落ちる", () =>
    Effect.gen(function* () {
      const client = inventoryClient({
        vms: [
          { vmid: 9300, name: "devvm", status: "running" },
          { vmid: 9200, name: "benchvm", status: "stopped" }
        ],
        networks: [{ iface: "vmbr0" }],
        sdnVnets: [{ vnet: "team1" }, { vnet: "team2" }, { vnet: "team3" }],
        benchvmBridges: ["team1", "team2"],
        isolationStatus: "active"
      })
      const inv = yield* inventoryOf(client)
      expect([...Option.getOrThrow(inv.preparedTeamNumbers)].sort()).toEqual([1, 2])
    })
  )

  it.effect("template VM が inventory に存在しなければ templateExists=false", () =>
    Effect.gen(function* () {
      const client = inventoryClient({
        vms: [
          { vmid: 9300, name: "devvm", status: "running" },
          { vmid: 9200, name: "benchvm", status: "stopped" }
        ],
        networks: [],
        benchvmBridges: [],
        isolationStatus: "active"
      })
      const inv = yield* inventoryOf(client)
      expect(inv.templateExists).toEqual(Option.some(false))
    })
  )

  // D3 回帰: mode token の ACL は /vms/9200 と /vms/9300 だけなので template
  // 9100 は mode 側の qemu 一覧に出ない。provision token で確認する。
  it.effect("template が provision credential にしか見えなくても templateExists=true", () =>
    Effect.gen(function* () {
      const client = inventoryClient({
        vms: [
          { vmid: 9300, name: "devvm", status: "running" },
          { vmid: 9200, name: "benchvm", status: "stopped" }
        ],
        provisionVms: [
          { vmid: 9100, name: "inucon-template", status: "stopped" },
          { vmid: 1101, name: "inucon-team1-1", status: "running" }
        ],
        networks: [{ iface: "team1" }, { iface: "team2" }],
        benchvmBridges: ["team1", "team2"],
        isolationStatus: "active"
      })
      const inv = yield* inventoryOf(client)
      expect(inv.templateExists).toEqual(Option.some(true))
      // mode 側の一覧にしか居ない devvm/benchvm は従来どおり観測できる。
      expect(Option.getOrThrow(inv.devvm)).toMatchObject({ vmid: 9300, name: "devvm" })
      expect(Option.getOrThrow(inv.benchvm)).toMatchObject({ vmid: 9200, name: "benchvm" })
    })
  )

  it.effect("isolation service が inactive/未定義(404)なら isolationServiceActive=Some(false)", () =>
    Effect.gen(function* () {
      const inactive = yield* inventoryOf(
        inventoryClient({
          vms: [
            { vmid: 9100, name: "inucon-template", status: "stopped" },
            { vmid: 9300, name: "devvm", status: "running" },
            { vmid: 9200, name: "benchvm", status: "stopped" }
          ],
          networks: [{ iface: "team1" }, { iface: "team2" }],
          benchvmBridges: ["team1", "team2"],
          isolationStatus: "inactive"
        })
      )
      expect(inactive.isolationServiceActive).toEqual(Option.some(false))

      const notFound = yield* inventoryOf(
        inventoryClient({
          vms: [
            { vmid: 9300, name: "devvm", status: "running" },
            { vmid: 9200, name: "benchvm", status: "stopped" }
          ],
          networks: [{ iface: "team1" }, { iface: "team2" }],
          benchvmBridges: ["team1", "team2"],
          isolationStatus: 404
        })
      )
      expect(notFound.isolationServiceActive).toEqual(Option.some(false))
    })
  )

  // D1 回帰: PVE 9.2.3 は /nodes/:node/services/:service/state の :service を
  // 固定 enum で検証し、カスタム unit には 404 ではなく 400 を返す。この 1 本が
  // inventory 全体を落とすと Proxmox 依存の 6 check が一律 unreadable になる。
  it.effect("isolation service state が 400 でも inventory 全体は落ちず、他フィールドは有効値を返す", () =>
    Effect.gen(function* () {
      const client = inventoryClient({
        vms: [
          { vmid: 9300, name: "devvm", status: "running", mem: 8 * 1024 * 1024 * 1024, onBoot: 1 },
          { vmid: 9200, name: "benchvm", status: "stopped", mem: 4 * 1024 * 1024 * 1024, onBoot: 0 }
        ],
        provisionVms: [{ vmid: 9100, name: "inucon-template", status: "stopped" }],
        networks: [{ iface: "vmbr0" }],
        sdnVnets: [{ vnet: "team1" }, { vnet: "team2" }],
        benchvmBridges: ["team1", "team2"],
        isolationStatus: 400,
        memoryFreeBytes: 6_000_000_000
      })
      const inv = yield* inventoryOf(client)
      // isolation だけが「取得不能」
      expect(inv.isolationServiceActive).toEqual(Option.none())
      // 残りはすべて有効値
      expect(inv.templateExists).toEqual(Option.some(true))
      expect(inv.nodeFreeMemBytes).toEqual(Option.some(6_000_000_000))
      expect([...Option.getOrThrow(inv.preparedTeamNumbers)].sort()).toEqual([1, 2])
      expect(Option.getOrThrow(inv.devvm)).toMatchObject({ vmid: 9300, name: "devvm" })
      expect(Option.getOrThrow(inv.benchvm)).toMatchObject({ vmid: 9200, name: "benchvm" })
    })
  )

  it.effect("devvm/benchvm が mode 一覧に居なくても inventory 全体は落ちず None になる", () =>
    Effect.gen(function* () {
      const client = inventoryClient({
        vms: [],
        provisionVms: [{ vmid: 9100, name: "inucon-template", status: "stopped" }],
        networks: [],
        sdnVnets: [{ vnet: "team1" }],
        benchvmBridges: ["team1"],
        isolationStatus: "active"
      })
      const inv = yield* inventoryOf(client)
      expect(inv.devvm).toEqual(Option.none())
      expect(inv.benchvm).toEqual(Option.none())
      expect(inv.templateExists).toEqual(Option.some(true))
      expect(inv.isolationServiceActive).toEqual(Option.some(true))
    })
  )
})
