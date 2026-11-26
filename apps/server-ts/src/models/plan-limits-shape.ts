import { PLAN_CREDITS } from "@arden-hq/protocol/runs"

export type StoredPlanCredits =
  | { readonly kind: typeof PLAN_CREDITS.unlimited }
  | {
      readonly kind: typeof PLAN_CREDITS.limited
      readonly available: boolean
      readonly balance: number | null
    }

export const hasPlanCredits = (credits: StoredPlanCredits | null | undefined): boolean =>
  credits?.kind === PLAN_CREDITS.unlimited || credits?.available === true

interface StoredPlanWindow {
  readonly used_percent: number
  readonly window_seconds: number
  readonly resets_at: string
  readonly pace: {
    readonly limit_percent: number
    readonly elapsed_percent: number
    readonly on_pace_percent: number
    readonly ahead: boolean
    readonly reaches_limit_at: string | null
  }
}

interface StoredPlanLimits {
  readonly provider: string
  readonly plan: string | null
  readonly windows: ReadonlyArray<StoredPlanWindow>
  readonly credits: StoredPlanCredits | null
  readonly observed_at: string
}

export interface StoredPlanLimitsReport {
  readonly plans: ReadonlyArray<StoredPlanLimits>
}
