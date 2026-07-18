import { Effect, Layer } from "effect"
import { CloudflareError, CloudflarePort, GithubKeysError, GithubKeysPort, ProxmoxError, ProxmoxPort } from "../application/ports.js"

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
  getNodeFreeMemBytes: Effect.fail(new ProxmoxError({ cause: DISABLED_MESSAGE }))
})

export const CloudflarePortStubLive: Layer.Layer<CloudflarePort> = Layer.succeed(CloudflarePort, {
  ensureInstanceRoute: () => Effect.fail(new CloudflareError({ cause: DISABLED_MESSAGE })),
  removeInstanceRoute: () => Effect.fail(new CloudflareError({ cause: DISABLED_MESSAGE })),
  ensureAccessApp: () => Effect.fail(new CloudflareError({ cause: DISABLED_MESSAGE })),
  removeAccessApp: () => Effect.fail(new CloudflareError({ cause: DISABLED_MESSAGE }))
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
