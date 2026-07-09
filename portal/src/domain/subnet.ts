import { Either } from "effect"
import { TargetIpOutOfSubnet } from "./errors.js"

// オクテット: "0" か、先頭ゼロなしの 1〜3 桁数字。文字列 prefix 比較を避け、
// オクテット単位の数値比較でチームサブネット(10.100.<teamNumber>.0/24)を判定する。
const OCTET_PATTERN = /^(0|[1-9]\d{0,2})$/

const parseOctets = (ip: string): ReadonlyArray<number> | undefined => {
  const parts = ip.split(".")
  if (parts.length !== 4) return undefined
  if (!parts.every((part) => OCTET_PATTERN.test(part))) return undefined
  const octets = parts.map(Number)
  if (octets.some((octet) => octet < 0 || octet > 255)) return undefined
  return octets
}

export const ipInTeamSubnet = (ip: string, teamNumber: number): boolean => {
  const octets = parseOctets(ip)
  if (octets === undefined) return false
  const [a, b, c] = octets
  return a === 10 && b === 100 && c === teamNumber
}

export const validateBenchTarget = (
  ip: string,
  teamNumber: number
): Either.Either<void, TargetIpOutOfSubnet> =>
  ipInTeamSubnet(ip, teamNumber)
    ? Either.right(undefined)
    : Either.left(new TargetIpOutOfSubnet({ ip, teamNumber }))
