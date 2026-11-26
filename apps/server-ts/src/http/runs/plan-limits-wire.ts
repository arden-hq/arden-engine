import {
  CREDIT_BALANCE,
  PLAN_CREDITS,
  PLAN_LIMIT_REACHED,
  PLAN_NAME,
  type PlanCredits,
  type PlanLimitsReport
} from "@arden-hq/protocol/runs"
import type { StoredPlanCredits, StoredPlanLimitsReport } from "../../models/plan-limits-shape.js"

const credits = (stored: StoredPlanCredits | null): PlanCredits => {
  if (stored === null) return { kind: PLAN_CREDITS.unreported }
  if (stored.kind === PLAN_CREDITS.unlimited) return { kind: PLAN_CREDITS.unlimited }
  return {
    kind: PLAN_CREDITS.limited,
    available: stored.available,
    balance:
      stored.balance === null
        ? { kind: CREDIT_BALANCE.unreported }
        : { kind: CREDIT_BALANCE.reported, amount: stored.balance }
  }
}

export const wirePlanLimits = (report: StoredPlanLimitsReport): PlanLimitsReport => ({
  plans: report.plans.map((plan) => ({
    provider: plan.provider,
    plan:
      plan.plan === null ? { kind: PLAN_NAME.unnamed } : { kind: PLAN_NAME.named, name: plan.plan },
    windows: plan.windows.map((window) => ({
      used_percent: window.used_percent,
      window_seconds: window.window_seconds,
      resets_at: window.resets_at,
      pace: {
        limit_percent: window.pace.limit_percent,
        elapsed_percent: window.pace.elapsed_percent,
        on_pace_percent: window.pace.on_pace_percent,
        ahead: window.pace.ahead,
        reaches_limit:
          window.pace.reaches_limit_at === null
            ? { kind: PLAN_LIMIT_REACHED.not_before_reset }
            : { kind: PLAN_LIMIT_REACHED.at, at: window.pace.reaches_limit_at }
      }
    })),
    credits: credits(plan.credits),
    observed_at: plan.observed_at
  }))
})
