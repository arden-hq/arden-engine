import type { RunBudget, RunBudgetOptions, RunBudgetSnapshot } from "../contracts/events.js"

const validCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

/** Create a small synchronous budget that can be shared between agent runs. */
export const makeRunBudget = (options: RunBudgetOptions = {}): RunBudget => {
  let current: RunBudgetSnapshot = {
    toolCalls: options.toolCalls ?? 0,
    outputTokens: options.outputTokens ?? 0,
    ...(options.totalOutputTokens === undefined
      ? {}
      : { totalOutputTokens: options.totalOutputTokens })
  }
  if (
    !validCount(current.toolCalls) ||
    !validCount(current.outputTokens) ||
    (current.totalOutputTokens !== undefined && !validCount(current.totalOutputTokens))
  ) {
    throw new RangeError("run budget counts must be non-negative safe integers")
  }
  return Object.freeze({
    snapshot: () => ({ ...current }),
    reserveToolCalls: (count: number, limit?: number): boolean => {
      if (!validCount(count) || (limit !== undefined && !validCount(limit))) {
        throw new RangeError("tool budget counts must be non-negative safe integers")
      }
      if (limit !== undefined && current.toolCalls + count > limit) return false
      current = { ...current, toolCalls: current.toolCalls + count }
      return true
    },
    addOutputTokens: (count: number): RunBudgetSnapshot => {
      if (!validCount(count))
        throw new RangeError("output token count must be a non-negative safe integer")
      current = { ...current, outputTokens: current.outputTokens + count }
      return { ...current }
    }
  })
}

export const validateBudgetSnapshot = (value: RunBudgetSnapshot): RunBudgetSnapshot => {
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger(value.toolCalls) ||
    value.toolCalls < 0 ||
    !Number.isSafeInteger(value.outputTokens) ||
    value.outputTokens < 0 ||
    (value.totalOutputTokens !== undefined &&
      (!Number.isSafeInteger(value.totalOutputTokens) || value.totalOutputTokens < 0))
  ) {
    throw new TypeError("budget snapshot must contain non-negative safe integer counts")
  }
  return value
}
