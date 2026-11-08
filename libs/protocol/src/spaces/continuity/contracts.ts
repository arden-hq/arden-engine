import type { JsonRecord } from "../../common/json.js"
import type { ContinuitySourceCursor } from "../../chat/communication.js"

export interface SpaceContinuitySeenState extends JsonRecord {
  readonly state_version: number
  readonly seen_through: ContinuitySourceCursor
  readonly acknowledged_at: string | null
}

export interface SpaceContinuityStateResponse extends JsonRecord {
  readonly seen: SpaceContinuitySeenState
}

export type RenderedContinuityRecord =
  | { readonly kind: "arrival"; readonly arrival_id: string }
  | { readonly kind: "question"; readonly question_id: string; readonly revision: number }

export interface AcknowledgeSpaceContinuityRequest {
  readonly expected_state_version: number
  readonly rendered: ReadonlyArray<RenderedContinuityRecord>
}
