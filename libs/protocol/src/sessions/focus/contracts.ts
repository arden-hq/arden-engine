import type { JsonRecord } from "../../common/json.js"

type SessionFocusStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete"

interface FocusEvidence extends JsonRecord {
  readonly text: string
  readonly created_at: string
}

export interface SessionFocus extends JsonRecord {
  readonly session_id: string
  readonly focus_id: string
  readonly objective: string
  readonly status: SessionFocusStatus
  readonly evidence: ReadonlyArray<FocusEvidence>
  readonly tokens_used: number
  readonly time_used_seconds: number
  readonly created_at: string
  readonly updated_at: string
}
