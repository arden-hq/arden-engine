import { cutText } from "@arden-hq/std/text"
import type { JsonRecord } from "../../common/json.js"

export const FOCUS_CHOICE_TARGET = { existing: "existing", create: "create" } as const

export type FocusChoiceTarget =
  | {
      readonly kind: typeof FOCUS_CHOICE_TARGET.existing
      readonly session_ref: string
      readonly label: string
    }
  | {
      readonly kind: typeof FOCUS_CHOICE_TARGET.create
      readonly name: string
    }

export const FOCUS_CHOICE_STATUS = { offered: "offered", settled: "settled" } as const

export type FocusChoiceStatus = (typeof FOCUS_CHOICE_STATUS)[keyof typeof FOCUS_CHOICE_STATUS]

export const FOCUS_CHOICE_DECISION = {
  continueHere: "continue_here",
  openTarget: "open_target"
} as const

export type FocusChoiceDecision = (typeof FOCUS_CHOICE_DECISION)[keyof typeof FOCUS_CHOICE_DECISION]

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

export function focusOpenLabel(target: FocusChoiceTarget): string {
  const label =
    target.kind === FOCUS_CHOICE_TARGET.existing
      ? `Continue in ${target.label}`
      : `Open a new chat: ${target.name}`
  return cutText(label, CHOICE_LABEL_MAX)
}
