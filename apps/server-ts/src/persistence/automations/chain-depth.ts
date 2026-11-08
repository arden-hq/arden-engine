import type { AutomationTriggerContext } from "@arden-hq/protocol/automations"

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

export const causedChainDepth = (
  producedBy: string | null,
  producerWakeDepth: number | undefined
): number => (producedBy === null ? 0 : (producerWakeDepth ?? 0) + 1)

export const chainMayWake = (chainDepth: number): boolean => chainDepth <= CHAIN_LIMIT
