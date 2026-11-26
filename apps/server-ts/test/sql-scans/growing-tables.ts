type RowsAfterFiveMonths =
  | number
  | "one per chat"
  | "one per untrimmed agent or forked chat"
  | "one or more per delivery"

const ROWS_AFTER_FIVE_MONTHS: Readonly<Record<string, RowsAfterFiveMonths>> = {
  journal_records: 459_000,
  session_messages: 449_000,
  message_turns: 449_000,
  tool_calls: 138_000,
  run_model_usage: 105_000,
  chat_idempotency_keys: 20_000,
  automation_runs: 19_000,
  session_turns: 17_000,
  chat_runs: 16_000,
  execution_budgets: 9_700,
  letter_subjects: 7_000,
  run_endings: 6_300,
  session_revisions: 6_200,
  sessions: 5_100,
  session_sizes: "one per chat",
  trace_trim_due: "one per untrimmed agent or forked chat",
  run_sidecars: 5_100,
  tool_call_targets: 4_900,
  journal_streams: 4_700,
  session_event_checkpoints: 4_700,
  approval_reviews: 4_200,
  automation_deliveries: 2_500,
  automation_delivery_runs: "one or more per delivery",
  home_presence: 2_400,
  usage_daily: 2_200,
  space_task_events: 2_000
}

export const GROWING_TABLES: ReadonlySet<string> = new Set(Object.keys(ROWS_AFTER_FIVE_MONTHS))
