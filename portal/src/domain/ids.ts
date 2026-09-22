import { Schema } from "effect"

// ID は一意な不透明文字列のブランド型。形式は生成側の責務
// (infrastructure の UuidGen が UUID を、SessionRepo が hex 乱数を生成)で、
// domain では形式を仮定しない。

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

// Task 1: 後続タスク (Task 6, 7, 11) が使う durable Operation / ResourceBinding /
// Artifact の識別子。ここでブランドを定義しておくことで、shared 側 wire schema
// (Task 6-) と domain 型を同じ名前で参照できる。
export const OperationId = Schema.String.pipe(Schema.brand("OperationId"))
export type OperationId = typeof OperationId.Type

export const OperationStepId = Schema.String.pipe(Schema.brand("OperationStepId"))
export type OperationStepId = typeof OperationStepId.Type

export const ResourceBindingId = Schema.String.pipe(Schema.brand("ResourceBindingId"))
export type ResourceBindingId = typeof ResourceBindingId.Type

export const ArtifactId = Schema.String.pipe(Schema.brand("ArtifactId"))
export type ArtifactId = typeof ArtifactId.Type
