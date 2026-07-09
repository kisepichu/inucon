import { Schema } from "effect"

// 全 ID は UUID 文字列のブランド型。

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const TeamId = Schema.String.pipe(Schema.brand("TeamId"))
export type TeamId = typeof TeamId.Type

export const ContestId = Schema.String.pipe(Schema.brand("ContestId"))
export type ContestId = typeof ContestId.Type

export const InstanceId = Schema.String.pipe(Schema.brand("InstanceId"))
export type InstanceId = typeof InstanceId.Type

export const BenchJobId = Schema.String.pipe(Schema.brand("BenchJobId"))
export type BenchJobId = typeof BenchJobId.Type

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type
