import type { ApprovalPresentation } from "../chat/approval-presentation.js"
import type { JsonRecord } from "../common/json.js"
import type { RunApprovalWork } from "./context.js"
import type { RuntimeConnectionSnapshot } from "../chat/runtime.js"
import type { RuleSavedIn } from "./questions.js"

/** One pending tool decision, addressed independently of the selected Chat. */
export interface RunApproval extends JsonRecord {
  readonly at: string
  readonly run_id: string
  /** The chat the asking run works in. */
  readonly session_id: string
  /** The chat this approval shows in: where the asking run belongs (a Task's
   *  run shows in the Task's chat, a helper agent's in its owner's). */
  readonly destination_session_id: string
  /** The Task or Automation the asking run works for, which names who asks. */
  readonly work: RunApprovalWork | null
  readonly tool_call_id: string
  readonly decision_delivery?: "blocking" | "deferred"
  readonly kind: string
  readonly connection: RuntimeConnectionSnapshot | null
  readonly tool_name: string
  readonly action: string
  readonly scope: string
  readonly preview: string | null
  readonly description: string | null
  readonly detail: string | null
  readonly subject: string | null
  /** Integration connection state when applicable; otherwise null. */
  readonly reason: string | null
  readonly presentation: ApprovalPresentation | null
  readonly diff: string | null
  /** Where the card's "Always allow" saves (`RuntimeApprovalSnapshot.rule_places`); empty when none can. */
  readonly rule_places: ReadonlyArray<RuleSavedIn>
  readonly can_attach_folder_to_space?: boolean
  /** The folder those choices keep, written for the card. */
  readonly grant_folder?: string
}
