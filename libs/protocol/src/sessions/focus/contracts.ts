import type { JsonRecord } from "../../common/json.js"

/* A chat's Goal, as older chat journals carry it in `focus_updated`. Goals
   became the Task a chat works on in place (goal-task-merge, migration 0044);
   nothing writes these now, and they are read only so old journals decode. */

type SessionFocusStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete"

interface FocusEvidence extends JsonRecord {
  readonly text: string
  readonly created_at: string
  readonly kind?: string
  readonly blocked_reason?: string
}

export interface SessionFocus extends JsonRecord {
  readonly session_id: string
  readonly focus_id: string
  readonly objective: string
  readonly status: SessionFocusStatus
  readonly evidence: ReadonlyArray<FocusEvidence>
  readonly blocked_reason?: string | null
  readonly token_budget?: number | null
  readonly tokens_used: number
  readonly time_used_seconds: number
  readonly created_at: string
  readonly updated_at: string
}
