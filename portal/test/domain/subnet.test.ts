import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { TargetIpOutOfSubnet } from "../../src/domain/errors.js"
import { ipInTeamSubnet, validateBenchTarget } from "../../src/domain/subnet.js"

describe("ipInTeamSubnet", () => {
  it("チームのサブネット内なら true", () => {
    expect(ipInTeamSubnet("10.100.1.11", 1)).toBe(true)
  })

  it("別チームのサブネットなら false", () => {
    expect(ipInTeamSubnet("10.100.2.11", 1)).toBe(false)
  })

  it("文字列 prefix の誤マッチを起こさない(10.100.1 が 10.100.10.5 に一致しない)", () => {
    expect(ipInTeamSubnet("10.100.10.5", 1)).toBe(false)
  })

  it("不正なオクテット(範囲外)なら false", () => {
    expect(ipInTeamSubnet("10.100.1.999", 1)).toBe(false)
  })

  it("先頭ゼロのオクテットは拒否", () => {
    expect(ipInTeamSubnet("10.100.01.11", 1)).toBe(false)
  })

  it("IPv6 表記は false", () => {
    expect(ipInTeamSubnet("::1", 1)).toBe(false)
  })
})

describe("validateBenchTarget", () => {
  it("サブネット内なら right(void)", () => {
    expect(validateBenchTarget("10.100.1.11", 1)).toStrictEqual(Either.right(undefined))
  })

  it("サブネット外なら TargetIpOutOfSubnet の left", () => {
    expect(validateBenchTarget("10.100.2.11", 1)).toStrictEqual(
      Either.left(new TargetIpOutOfSubnet({ ip: "10.100.2.11", teamNumber: 1 }))
    )
  })
})
