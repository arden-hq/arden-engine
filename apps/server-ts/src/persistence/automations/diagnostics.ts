export interface QueueRow {
  readonly queue_id: number
  readonly task_id: string
  readonly automation_ref: string
  readonly name: string
  readonly source: string
  readonly enabled: number
  readonly created_at: string
  readonly claimed_at: string | null
  readonly lease_expires_at: string | null
  readonly next_attempt_at: string | null
  readonly attempt_count: number
  readonly last_error: string | null
  readonly running_since: string | null
  readonly chat_run_id: string | null
  readonly chat_status: string | null
  readonly destination_chat_status: string | null
  readonly pending_task_question: number
  readonly session_id: string | null
}

export interface ScheduleRow {
  readonly task_id: string
  readonly automation_ref: string
  readonly name: string
  readonly enabled: number
  readonly next_run_at: string | null
  readonly running_since: string | null
  readonly last_run_at: string | null
  readonly cooldown_minutes: number | null
  readonly session_id: string | null
  readonly active_chat_status: string | null
}

export interface AutomationDiagnostics {
  readonly observed_at: string
  readonly selected_automation_ref: string | null
  readonly queue_counts: {
    readonly total: number
    readonly leased: number
    readonly expired: number
    readonly unclaimed: number
    readonly deferred: number
  }
  readonly queue: ReadonlyArray<QueueRow>
  readonly queue_has_more: boolean
  readonly schedules: ReadonlyArray<ScheduleRow>
  readonly schedules_has_more: boolean
}
