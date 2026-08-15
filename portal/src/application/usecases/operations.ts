// Task 6: OperationHandler の StepOutcome 型と worker 側で使う共通定数。
// ハンドラの実装は Task 7 以降で provider Layer に応じて register される。

export type StepOutcome =
  | { readonly status: "succeeded"; readonly summary: string }
  | { readonly status: "retry"; readonly retryAt: number; readonly summary: string }
  | { readonly status: "blocked"; readonly summary: string }

// worker Layer / retry 計算の既定値。env で上書き可能(main.ts で Config)。
export const DEFAULT_OPERATION_POLL_INTERVAL_MILLIS = 1_000
export const DEFAULT_OPERATION_RETRY_BASE_MILLIS = 1_000
export const DEFAULT_OPERATION_RETRY_MAX_MILLIS = 30_000
export const DEFAULT_OPERATION_MAX_ATTEMPTS = 5
export const DEFAULT_OPERATION_LEASE_DURATION_MILLIS = 60_000
