import { addCost } from "@arden-hq/loop"
import type { UsageDailyCell } from "@arden-hq/protocol/runs"

export type UsageMoney =
  | { readonly state: "reported"; readonly usd: number; readonly reason: string }
  | { readonly state: "unavailable"; readonly reason: string }

/**
 * The money a usage window cost, for `usage_report`: the dollars providers
 * reported (`RunUsage.cost`) when every recorded call has them, and
 * unavailable otherwise, since a partial sum would read as the whole spend.
 */
export const usageMoney = (daily: ReadonlyArray<Pick<UsageDailyCell, "cost">>): UsageMoney => {
  if (daily.length === 0)
    return { state: "unavailable", reason: "No recorded calls in this window." }
  const usd = daily.reduce<number | undefined>((sum, row) => addCost(sum, row.cost), 0)
  return usd === undefined
    ? {
        state: "unavailable",
        reason:
          "Some recorded calls' providers report no cost (Codex, llama.cpp), so this report measures tokens, not billed cost or subscription limits."
      }
    : {
        state: "reported",
        usd,
        reason:
          "What the model providers reported charging for every recorded call (OpenRouter reports it). Not a subscription's limits."
      }
}
