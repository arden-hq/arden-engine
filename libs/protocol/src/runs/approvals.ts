import type {
  ApprovalAsker,
  ApprovalCard,
  ApprovalDiff,
  ApprovalGrantFolder,
  ApprovalPreview,
  RuntimeConnectionSnapshot
} from "../chat/runtime.js"
import type { JsonRecord } from "../common/json.js"
import type { RuleSavedIn } from "./questions.js"

export const APPROVAL_TEXT = { none: "none", text: "text" } as const

export type RunApprovalText =
  | { readonly kind: typeof APPROVAL_TEXT.none }
  | { readonly kind: typeof APPROVAL_TEXT.text; readonly text: string }

export const APPROVAL_CONNECTION = { none: "none", connection: "connection" } as const

export type RunApprovalConnection =
  | { readonly kind: typeof APPROVAL_CONNECTION.none }
  | {
      readonly kind: typeof APPROVAL_CONNECTION.connection
      readonly connection: RuntimeConnectionSnapshot
    }

export interface RunApproval extends JsonRecord {
  readonly at: string
  readonly run_id: string
  readonly session_id: string
  readonly destination_session_id: string
  readonly asker: ApprovalAsker
  readonly tool_call_id: string
  readonly decision_delivery: "blocking" | "deferred"
  readonly kind: string
  readonly connection: RunApprovalConnection
  readonly tool_name: string
  readonly action: string
  readonly preview: ApprovalPreview
  readonly description: RunApprovalText
  readonly detail: RunApprovalText
  readonly subject: RunApprovalText
  readonly card: ApprovalCard
  readonly diff: ApprovalDiff
  readonly rule_places: ReadonlyArray<RuleSavedIn>
  readonly can_attach_folder_to_space: boolean
  readonly grant_folder: ApprovalGrantFolder
}
