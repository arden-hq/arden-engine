import { cutText } from "@arden-hq/std/text"
import type { JsonRecord } from "../../common/json.js"

export type FocusChoiceTarget =
  | {
      readonly kind: "existing"
      readonly session_ref: string
      readonly label: string
    }
  | {
      readonly kind: "create"
      readonly name: string
    }

export const FOCUS_CHOICE_STATUS = { offered: "offered", settled: "settled" } as const

export type FocusChoiceDecision = "continue_here" | "open_target"

interface FocusChoiceFields extends JsonRecord {
  readonly choice_id: string
  readonly question_id: string
  readonly source_session_id: string
  readonly space_id: string
  readonly revision: number
  readonly target: FocusChoiceTarget
  readonly created_at: string
  readonly updated_at: string
}

export interface OfferedFocusChoice extends FocusChoiceFields {
  readonly status: typeof FOCUS_CHOICE_STATUS.offered
}

export interface SettledFocusChoice extends FocusChoiceFields {
  readonly status: typeof FOCUS_CHOICE_STATUS.settled
  readonly decision: FocusChoiceDecision
  readonly result_session_ref: string
  readonly settled_at: string
}

export type FocusChoice = OfferedFocusChoice | SettledFocusChoice

export interface ResolveFocusChoiceInput {
  readonly expected_revision: number
  readonly client_id: string
  readonly decision: FocusChoiceDecision
}

export interface ResolveFocusChoiceResponse extends JsonRecord {
  readonly choice: SettledFocusChoice
  readonly session_ref: string
  readonly created: boolean
}

const CHOICE_LABEL_MAX = 160

/** The "open" door's words, named for where it goes: the button, the stored
 *  answer label and the answered line all say this, never "Open target". */
export function focusOpenLabel(target: FocusChoiceTarget): string {
  const label =
    target.kind === "existing" ? `Continue in ${target.label}` : `Open a new chat: ${target.name}`
  return cutText(label, CHOICE_LABEL_MAX)
}
