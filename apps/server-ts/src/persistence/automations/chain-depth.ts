import { RUN_ORIGIN } from "@arden-hq/protocol/runs"
import { JOB_PURPOSE, type JobPurpose } from "../job-classification.js"
import { type RunOrigin } from "../runs/stored-context.js"
import { AUTOMATION_TRIGGER_SOURCE } from "@arden-hq/protocol/effect/automations"
import type { AutomationTriggerContext } from "@arden-hq/protocol/automations"

const CHAIN_LIMIT = 1

export const wakeChainDepth = (wokenBy: AutomationTriggerContext | undefined): number => {
  if (wokenBy === undefined) return 0
  switch (wokenBy.source) {
    case AUTOMATION_TRIGGER_SOURCE.coalesced:
      return Math.max(0, ...wokenBy.causes.map(wakeChainDepth))
    case AUTOMATION_TRIGGER_SOURCE.event:
      return wokenBy.chain_depth
    case AUTOMATION_TRIGGER_SOURCE.scheduled:
    case AUTOMATION_TRIGGER_SOURCE.manual:
    case AUTOMATION_TRIGGER_SOURCE.home:
    case AUTOMATION_TRIGGER_SOURCE.idle:
    case AUTOMATION_TRIGGER_SOURCE.count:
    case AUTOMATION_TRIGGER_SOURCE.wake:
      return 0
  }
}

export const originChainDepth = (origin: RunOrigin): number =>
  origin.kind === RUN_ORIGIN.unrecorded ? 0 : (origin.chain_depth ?? 0)

export const causedChainDepth = (
  producedBy: string | null,
  producerWakeDepth: number | undefined
): number => (producerWakeDepth ?? 0) + (producedBy === null ? 0 : 1)

export const chainMayWake = (chainDepth: number, listener: JobPurpose): boolean =>
  listener === JOB_PURPOSE.system || chainDepth <= CHAIN_LIMIT
