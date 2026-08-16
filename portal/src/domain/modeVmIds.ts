// Task 8 review round 3 finding 3: 共通インフラ VM(devvm / benchvm)の
// VMID の single source of truth。以前は infra 層(proxmox/client.ts)にだけ
// 定義し、application 層(usecases/modeOperation.ts)は infra から re-export
// していた(app→infra の inverted import)。ここに置き直すことで:
// - application 層のテスト(modeOperation.test.ts)は domain だけ import する。
// - infra 層(proxmox/client.ts)も domain から import する。
// - hexagonal の依存方向(app → domain、infra → domain)を維持する。
//
// これらは実運用の固定値(2026-08 現在の Proxmox 上の VMID)。renumbering は
// runbook で 1 箇所だけ更新すれば app / infra 両方に届く。

export const DEVVM_VMID = 9200
export const BENCHVM_VMID = 9300

export const isModeVmid = (vmid: number): boolean =>
  vmid === DEVVM_VMID || vmid === BENCHVM_VMID
