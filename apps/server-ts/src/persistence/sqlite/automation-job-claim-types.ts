import { type Effect } from "effect"
import { type AutomationStoreError, type ClaimedAutomationJobLease } from "../automations/store.js"
import { type JobClaimInput } from "@arden-hq/jobs"
import { type ClaimedPrompt } from "./automation-claimed-prompt.js"

export interface AutomationJobClaim {
  readonly claimEffect: (
    input: JobClaimInput
  ) => Effect.Effect<Array<ClaimedAutomationJobLease>, AutomationStoreError>
  readonly claimedPrompt: ClaimedPrompt
}
