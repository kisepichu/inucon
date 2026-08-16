import { Effect, Layer } from "effect"
import { CloudflareError, CloudflarePort, GithubKeysError, GithubKeysPort, ModeTransitionTimeout, ProxmoxError, ProxmoxPort } from "../application/ports.js"

// PROXMOX_API_URL 未設定の env(dev/現行本番)向けのフォールバック実装
// (main.ts のコメント参照)。実 Live(Proxmox/Cloudflare/GithubKeys)は
// いずれも対応する env(PROXMOX_*/CF_*)を Layer 構築時に必須とするため、
// 未設定のまま provide すると Layer 構築自体が ConfigError で失敗し、
// ApiLive(ひいては HTTP サーバー全体)が起動できなくなる。
//
// ここでは Layer 構築そのものは常に成功させ、各メソッド呼び出し時にだけ
// 「PROXMOX_API_URL 未設定のためインスタンス操作は無効」という趣旨の
// 型付きエラーを返す。これにより:
// - invites.ts の招待エンドポイントは env 未設定でも「ポータル割当
//   (team_members/team_invites)」自体は成功させたまま、Access/鍵注入だけを
//   結果の error フィールドに degrade できる(syncRunningInstances が
//   Effect.either で拾う設計、締め出し・全滅を防ぐ)。
// - Proxmox の運用時 running インスタンスが 0 件のテストでは、そもそも
//   syncRunningInstances のループ自体を通らないためこのエラーは表面化しない。
const DISABLED_MESSAGE = "PROXMOX_API_URL 未設定のためインスタンス操作は無効です"

export const ProxmoxPortStubLive: Layer.Layer<ProxmoxPort> = Layer.succeed(ProxmoxPort, {
  cloneVm: () => Effect.fail(new ProxmoxError({ cause: DISABLED_MESSAGE })),
  configureCloudInit: () => Effect.fail(new ProxmoxError({ cause: DISABLED_MESSAGE })),
  setVnet: () => Effect.fail(new ProxmoxError({ cause: DISABLED_MESSAGE })),
  startVm: () => Effect.fail(new ProxmoxError({ cause: DISABLED_MESSAGE })),
  stopAndDestroyVm: () => Effect.fail(new ProxmoxError({ cause: DISABLED_MESSAGE })),
  vmExists: () => Effect.fail(new ProxmoxError({ cause: DISABLED_MESSAGE })),
  waitForGuestAgent: () => Effect.fail(new ProxmoxError({ cause: DISABLED_MESSAGE })),
  guestExec: () => Effect.fail(new ProxmoxError({ cause: DISABLED_MESSAGE })),
  getNodeFreeMemBytes: Effect.fail(new ProxmoxError({ cause: DISABLED_MESSAGE })),
  // Task 7: 未設定時の reconciliation plan は「Proxmox 側は observation 無し」と
  // して振る舞う(空配列)。ambiguous 誤検出を避けるため fail ではなく空を返す
  // — CF 側の resource は unmanaged_orphan として現れるが blocked のままに
  // なるので operator が明示 adopt しない限り安全側。
  listManagedVms: Effect.succeed([]),
  // Task 8: infrastructure inventory / mode primitives も no-op で
  // ProxmoxError を返す(readiness は fail, mode operation は blocked に落ちる)。
  getInfrastructureInventory: Effect.fail(new ProxmoxError({ cause: DISABLED_MESSAGE })),
  setVmOnBoot: () => Effect.fail(new ProxmoxError({ cause: DISABLED_MESSAGE })),
  shutdownVm: () => Effect.fail(new ProxmoxError({ cause: DISABLED_MESSAGE })),
  waitForVmStatus: (vmid, expected, timeoutMillis) =>
    Effect.fail(new ModeTransitionTimeout({ vmid, expected, timeoutMillis }))
})

export const CloudflarePortStubLive: Layer.Layer<CloudflarePort> = Layer.succeed(CloudflarePort, {
  ensureInstanceRoute: () => Effect.fail(new CloudflareError({ cause: DISABLED_MESSAGE })),
  removeInstanceRoute: () => Effect.fail(new CloudflareError({ cause: DISABLED_MESSAGE })),
  ensureAccessApp: () => Effect.fail(new CloudflareError({ cause: DISABLED_MESSAGE })),
  removeAccessApp: () => Effect.fail(new CloudflareError({ cause: DISABLED_MESSAGE })),
  // 上記 listManagedVms と同じ理由で inventory は空で返す(fail ではなく)。
  getInstanceInventory: Effect.succeed({ routes: [], apps: [] }),
  // Task 8: probe は「未設定」= fail(readiness の cloudflare_token=fail 相当)。
  probe: Effect.fail(new CloudflareError({ cause: DISABLED_MESSAGE }))
})

export const GithubKeysPortStubLive: Layer.Layer<GithubKeysPort> = Layer.succeed(GithubKeysPort, {
  fetchKeys: () => Effect.fail(new GithubKeysError({ cause: DISABLED_MESSAGE }))
})

// 3 port まとめて 1 つの Layer として main.ts から参照する(ApiLive /
// ProvisionerConditionalLive 双方に同じ「env 無しフォールバック」を配線する)。
export const InstancePortsStubLive: Layer.Layer<ProxmoxPort | CloudflarePort | GithubKeysPort> = Layer.mergeAll(
  ProxmoxPortStubLive,
  CloudflarePortStubLive,
  GithubKeysPortStubLive
)
