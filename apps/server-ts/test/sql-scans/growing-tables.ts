/**
 * Tables that grow with use: one row or more per message, tool call, run,
 * chat or day. A query that reads one of these from start to end gets slower
 * for as long as the app is used. Counts are from a five-month database.
 */
export const GROWING_TABLES: ReadonlySet<string> = new Set([
  "journal_records", // 459,000
  "session_messages", // 449,000
  "message_turns", // 449,000
  "tool_calls", // 138,000
  "run_model_usage", // 105,000
  "chat_idempotency_keys", // 20,000
  "automation_runs", // 19,000
  "session_turns", // 17,000
  "chat_runs", // 16,000
  "execution_budgets", // 9,700
  "letter_subjects", // 7,000
  "run_endings", // 6,300
  "session_revisions", // 6,200
  "sessions", // 5,100
  "session_sizes", // one per chat
  "trace_trim_due", // one per untrimmed agent or forked chat
  "run_sidecars", // 5,100
  "tool_call_targets", // 4,900
  "journal_streams", // 4,700
  "session_event_checkpoints", // 4,700
  "approval_reviews", // 4,200
  "automation_deliveries", // 2,500
  "automation_delivery_runs", // one or more per delivery
  "home_presence", // 2,400
  "usage_daily", // 2,200
  "space_task_events" // 2,000
])
