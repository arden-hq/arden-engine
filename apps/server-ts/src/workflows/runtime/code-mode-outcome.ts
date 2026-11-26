import type { Schema } from "effect"

export const CODE_MODE_STATUS = {
  completed: "completed",
  failed: "failed"
} as const

export const CODE_MODE_FAILURE = {
  cancelled: "cancelled",
  timedOut: "timed_out",
  runtime: "runtime"
} as const

export type CodeModeFailure = (typeof CODE_MODE_FAILURE)[keyof typeof CODE_MODE_FAILURE]

export type CodeModeOutcome =
  | {
      readonly status: typeof CODE_MODE_STATUS.completed
      readonly value: Schema.Json
      readonly calls: ReadonlyArray<string>
    }
  | {
      readonly status: typeof CODE_MODE_STATUS.failed
      readonly error: string
      readonly reason: CodeModeFailure
      readonly calls: ReadonlyArray<string>
    }
