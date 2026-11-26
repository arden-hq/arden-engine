import { StopReason } from "../contracts/events.js"
import { budgetStopReason } from "./policy.js"
import { callbackFailure, invoke } from "./guards.js"
import { type Run } from "./run-state.js"

export const currentCost = async (run: Run): Promise<number> => {
  const getter = run.wiring.costGetter
  if (getter === undefined) return run.state.localCost
  let cost: number
  try {
    cost = await (typeof getter === "function" ? getter() : getter)
  } catch (cause) {
    throw callbackFailure("costGetter", cause)
  }
  if (!Number.isFinite(cost) || cost < 0) {
    throw callbackFailure("costGetter", new RangeError("cost must be finite and non-negative"))
  }
  return cost
}

export const stopForBudget = async (run: Run): Promise<StopReason | null> => {
  const snapshot = await run.budget.snapshot()
  const nowMs = invoke("clock", run.wiring.clock)
  const cost = await currentCost(run)
  return budgetStopReason({
    config: run.wiring.config,
    budget: snapshot,
    startedAtMs: run.state.startedAtMs,
    nowMs,
    cost
  })
}
