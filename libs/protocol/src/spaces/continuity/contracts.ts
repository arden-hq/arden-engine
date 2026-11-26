import type { JsonRecord } from "../../common/json.js"
import type { ContinuitySourceCursor } from "../../chat/communication.js"

export const SEEN_ACKNOWLEDGEMENT = { never: "never", acknowledged: "acknowledged" } as const

export type SeenAcknowledgement =
  | { readonly kind: typeof SEEN_ACKNOWLEDGEMENT.never }
  | { readonly kind: typeof SEEN_ACKNOWLEDGEMENT.acknowledged; readonly at: string }

export interface SpaceContinuitySeenState extends JsonRecord {
  readonly state_version: number
  readonly seen_through: ContinuitySourceCursor
  readonly acknowledgement: SeenAcknowledgement
}

export interface SpaceContinuityStateResponse extends JsonRecord {
  readonly seen: SpaceContinuitySeenState
}

export const RENDERED_CONTINUITY_RECORD = { arrival: "arrival", question: "question" } as const

export type RenderedContinuityRecord =
  | { readonly kind: typeof RENDERED_CONTINUITY_RECORD.arrival; readonly arrival_id: string }
  | {
      readonly kind: typeof RENDERED_CONTINUITY_RECORD.question
      readonly question_id: string
      readonly revision: number
    }

export interface AcknowledgeSpaceContinuityRequest {
  readonly expected_state_version: number
  readonly rendered: ReadonlyArray<RenderedContinuityRecord>
}
