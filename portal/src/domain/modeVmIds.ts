// Task 8 review round 3 finding 3: 共通インフラ VM(devvm / benchvm)の
// VMID の single source of truth。以前は infra 層(proxmox/client.ts)にだけ
// 定義し、application 層(usecases/modeOperation.ts)は infra から re-export
// していた(app→infra の inverted import)。ここに置き直すことで:
// - application 層のテスト(modeOperation.test.ts)は domain だけ import する。
// - infra 層(proxmox/client.ts)も domain から import する。
// - hexagonal の依存方向(app → domain、infra → domain)を維持する。
//
// 値は実機 eevee の `qm list` / `qm config` 実測値(2026-09-22):
//   9200 = benchvm (name: benchvm, memory 4096 MiB, onboot 0, stopped) — bench runner VM
//   9300 = devvm (name: devvm, memory 12288 MiB, onboot 1, running) — 開発サーバ
// `../nixos-config-private/scripts/eevee-mode.sh` の名前検証
// (「expected exactly one devvm VM named devvm with VMID 9300」/
//  「expected exactly one benchvm VM named benchvm with VMID 9200」)と一致する。
// 以前はこの 2 定数が実機と逆で、enter_contest_mode が「devvm を停止」と称して
// bench runner (benchvm) を落とし、「benchvm を起動」と称して開発サーバ
// (devvm) を起動する状態だった。
//
// renumbering しても VMID 決め打ちだけでは事故らない: mode step (modeOperation.ts /
// cleanup.ts) と readiness は power 操作を出す前に observed name を必ず突き合わせ、
// 不一致なら fail closed(blocked / fail)で止まる。modeVmIdentityMismatch を参照。
export const DEVVM_VMID = 9300
export const BENCHVM_VMID = 9200

// fail-closed 検証の期待名。eevee-mode.sh の `case $name in devvm) … benchvm)`
// と同じ「名前が正、VMID は裏取りされる側」という思想。
export const DEVVM_VM_NAME = "devvm"
export const BENCHVM_VM_NAME = "benchvm"

export const isModeVmid = (vmid: number): boolean =>
  vmid === DEVVM_VMID || vmid === BENCHVM_VMID

// provider から観測した mode VM の同一性検査に必要な最小 shape。
// application/ports.ts の VmInventoryItem が構造的に満たす(domain → app の
// 逆向き import を作らないため structural に留める)。
export interface ObservedModeVm {
  readonly vmid: number
  readonly name: string
}

// observed name が期待名と一致しなければ固定文の mismatch summary を返し、
// 一致すれば null。判定材料は observed name だけ — VMID から name を推定/上書き
// するような逆方向の実装にはしない(それでは mapping のズレを検出できない)。
// summary は provider raw response / credential を一切含まない固定文。
const nameMismatch = (observed: ObservedModeVm, expectedName: string): string | null =>
  observed.name === expectedName
    ? null
    : `VMID mapping mismatch: VM ${observed.vmid} is named '${observed.name}', ` +
      `expected '${expectedName}'; verify /vms mapping before any power operation`

// mode transition / readiness が power 操作の前に必ず通す fail-closed ガード。
// devvm / benchvm の両方を検査し、最初の不一致の summary を返す(両方一致なら
// null)。片方だけズレていても mapping 全体が疑わしいので mode transition は
// 進めない — force stop 禁止と同格の安全弁として扱う(retry もしない)。
export const modeVmIdentityMismatch = (observed: {
  readonly devvm: ObservedModeVm
  readonly benchvm: ObservedModeVm
}): string | null =>
  nameMismatch(observed.devvm, DEVVM_VM_NAME) ?? nameMismatch(observed.benchvm, BENCHVM_VM_NAME)
