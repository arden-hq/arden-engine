import type { AutomationTriggerContext } from "@arden-hq/protocol/automations"
import type { RunOrigin } from "@arden-hq/protocol/runs"

const CHAIN_LIMIT = 1

export const wakeChainDepth = (wokenBy: AutomationTriggerContext | undefined): number => {
  if (wokenBy === undefined) return 0
  switch (wokenBy.source) {
    case "coalesced":
      return Math.max(0, ...wokenBy.causes.map(wakeChainDepth))
    case "event":
      return wokenBy.chain_depth ?? 0
    case "scheduled":
    case "manual":
    case "home":
    case "idle":
    case "count":
    case "wake":
      return 0
  }
}

/** The depth of the wake that started a run: every run a wake starts carries it in its origin. */
export const originChainDepth = (origin: RunOrigin): number =>
  origin.kind === "unrecorded" ? 0 : (origin.chain_depth ?? 0)

/** Automation runs behind a change: those behind the wake of the run that made it, plus that run
 *  when it is an Automation's. A change by the owner or the outside world has none. */
export const causedChainDepth = (
  producedBy: string | null,
  producerWakeDepth: number | undefined
): number => (producerWakeDepth ?? 0) + (producedBy === null ? 0 : 1)

export const chainMayWake = (chainDepth: number): boolean => chainDepth <= CHAIN_LIMIT
