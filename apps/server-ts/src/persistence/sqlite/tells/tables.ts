import type { databaseSchema } from "../../schema/database.js"

type SchemaTable = (typeof databaseSchema.tables)[number]

export type TellKind =
  | "session"
  | "space"
  | "automation"
  | "permission"
  | "task"
  | "proposal"
  | "focus_choice"
  | "task_visibility"
  | "run_card"

interface ToldTable {
  readonly tell: TellKind
  readonly id: string
  readonly scope?: string
  readonly scopeTells?: TellKind
  readonly columns?: ReadonlyArray<string>
  readonly compare?: ReadonlyArray<string>
  readonly nameChanged?: string
  readonly unlistedChanged?: string
}

interface SilentTable {
  readonly silent: string
}

export type TableTell = ToldTable | SilentTable

const metadataPath = (path: string, row = "{row}") =>
  `json_extract(CASE WHEN json_valid(${row}.metadata) THEN ${row}.metadata ELSE '{}' END, '${path}')`

const sessionPermissionPaths = ["$.approval_mode"]

const sessionColumns = [
  "name",
  "archived_at",
  "session_type",
  "space_id",
  "chat_model",
  "parent_session_id",
  "parent_message_id",
  "origin_automation_id"
]

const transcript = "A chat's transcript: the chat's own stream tells each change."
const run =
  "A run's machinery: run events on its chat's stream and session_activity tell its state."
const ask = "An ask: the commit-time ask check (shown-asks.ts) tells every chat that shows it."
const history = "History of a told row: the row's own table tells; history is read when opened."
const automationRuntime =
  "Automation worker bookkeeping: automation_progress and automation_finished tell its runs."
const journal = "The event journal itself."
const ownSetting =
  "A setting the owner changes on one screen, which applies the response; nothing else writes it."
const internal = "Internal bookkeeping that no screen shows."
const files = "File lifecycle bookkeeping that no screen shows."
const pipeline =
  "The connections pipeline: what reaches the owner is a proposal or a Task, told by theirs."
const search = "Search index sync; search reads it on each query."
const delivered = "What a run told: delivered into a chat, whose stream tells it."

export const tableTells = {
  model_settings: { silent: ownSetting },
  spaces: { tell: "space", id: "{row}.space_id" },
  sessions: {
    tell: "session",
    id: "{row}.session_id",
    scope: "{row}.space_id",
    scopeTells: "space",
    columns: [...sessionColumns, "metadata"],
    compare: [
      ...sessionColumns.map((column) => `{row}.${column}`),
      ...[...sessionPermissionPaths, "$.triage", "$.fork", "$.thread", "$.capture"].map((path) =>
        metadataPath(path)
      )
    ],
    nameChanged: "OLD.name IS NOT NEW.name",
    unlistedChanged: sessionPermissionPaths
      .map((path) => `${metadataPath(path, "OLD")} IS NOT ${metadataPath(path, "NEW")}`)
      .join(" OR ")
  },
  drive_uploads: {
    silent: "Internal upload identity survives retries; the tool result reports the uploaded file."
  },
  session_fork_requests: { silent: run },
  session_messages: { silent: transcript },
  session_turns: { silent: transcript },
  session_context_hidden: { silent: transcript },
  session_context_stage: {
    silent: "Internal resumable conversion state; active context tells at cutover."
  },
  chat_event_cursors: { silent: internal },
  session_pending_archives: {
    silent: "No screen shows the wish; the archive it leads to is told as the chat's change."
  },
  chat_event_deliveries: { silent: internal },
  answer_block_state: { silent: transcript },
  message_turns: { silent: transcript },
  chat_runs: { silent: run },
  run_model_usage: { silent: "Usage: Settings reads it when opened." },
  execution_budgets: { silent: ownSetting },
  chat_idempotency_keys: { silent: internal },
  session_queued_messages: { silent: transcript },
  tool_calls: { silent: run },
  tool_call_targets: { silent: run },
  tool_approvals: {
    tell: "run_card",
    id: "json_array({row}.run_id, {row}.tool_call_id)",
    columns: ["status"]
  },
  deferred_tool_calls: { silent: ask },
  pending_decision_visibility: { silent: ask },
  pending_decision_visibility_unresolved: { silent: ask },
  shown_asks: { silent: ask },
  journaled_decision_routes: { silent: ask },
  approval_reviews: { silent: run },
  session_todos: { silent: transcript },
  run_sidecars: { silent: run },
  chat_compactions: { silent: run },
  journal_streams: { silent: journal },
  journal_records: { silent: journal },
  session_event_checkpoints: { silent: journal },
  journal_retention_cursors: { silent: journal },
  journal_retention_held: { silent: journal },
  letter_subjects: { silent: "Home's letter reads it when it writes the next letter." },
  usage_daily: { silent: "Usage: Settings reads it when opened." },
  transcript_search_clock: { silent: search },
  transcript_search_changes: { silent: search },
  transcript_search_source: { silent: search },
  scheduled_tasks: {
    tell: "automation",
    id: "{row}.task_id",
    columns: [
      "name",
      "description",
      "prompt",
      "model",
      "context_mode",
      "triggers",
      "enabled",
      "paused_at",
      "next_run_at",
      "auto_approve",
      "cooldown_minutes",
      "thread_id",
      "tool_scope",
      "owner_space_id",
      "owner_task_id",
      "instruction_revision_id"
    ]
  },
  automation_instruction_revisions: { silent: history },
  automation_instruction_candidates: { silent: history },
  automation_runs: { silent: automationRuntime },
  automation_deliveries: { silent: automationRuntime },
  delivery_incidents: { silent: automationRuntime },
  automation_event_dedupe: { silent: automationRuntime },
  automation_event_queue: { silent: automationRuntime },
  automation_count_state: { silent: automationRuntime },
  automation_idle_state: { silent: automationRuntime },
  automation_trigger_cursor: { silent: automationRuntime },
  space_tasks: {
    tell: "task",
    id: "{row}.item_id",
    scope: "{row}.space_id",
    columns: [
      "space_id",
      "text",
      "body",
      "status",
      "owner",
      "runs_in",
      "blocked",
      "waiting_on",
      "due_at",
      "next_attempt_at",
      "completed_at",
      "home_session_id"
    ]
  },
  space_task_sources: { tell: "task", id: "{row}.item_id" },
  space_task_result_reads: { tell: "task_visibility", id: "{row}.item_id" },
  space_task_holds: { tell: "task", id: "{row}.item_id" },
  task_inference_rejections: {
    silent: "What Space review learned not to propose; prompts read it."
  },
  run_questions: { silent: ask },
  run_question_timers: { silent: ask },
  space_task_events: { tell: "task", id: "{row}.item_id", scope: "{row}.space_id" },
  space_task_comments: { tell: "task", id: "{row}.item_id", scope: "{row}.space_id" },
  space_task_attachments: { tell: "task", id: "{row}.item_id", scope: "{row}.space_id" },
  home_presence: { silent: "Home reads it when it opens and on its own refresh." },
  home_letter: { silent: "Home reads it when it opens and on its own refresh." },
  home_letters: { silent: "Home reads it when it opens and on its own refresh." },
  inbox_reads: { silent: "The Inbox that marked it applies it; the Inbox rereads on its own." },
  inbox_dismissals: {
    silent: "The Inbox that dismissed it applies it; the Inbox rereads on its own."
  },
  monitor_state: { silent: internal },
  browser_procedure_settings: {
    silent: "The browser learning screen reads and applies its own settings changes."
  },
  browser_procedures: {
    silent:
      "The browser learning screen refreshes the catalog when opened and after its own changes."
  },
  browser_procedure_revisions: {
    silent: "Immutable code and evidence are read from the browser procedure detail on request."
  },
  browser_procedure_jobs: {
    silent:
      "The durable job worker owns learning leases and the browser learning screen reads their status."
  },
  browser_procedure_invocations: {
    silent:
      "Browser procedure work is already reported by its normal durable tool and script records."
  },
  wiki_rename_approvals: {
    silent: "Wiki: its change sink (wiki/service.ts) tells every Wiki write."
  },
  storage_settings: { silent: ownSetting },
  storage_retention: { silent: ownSetting },
  session_file_cleanup: { silent: files },
  managed_output_gc_candidates: { silent: files },
  managed_output_lifecycle_lock: { silent: files },
  chat_upload_cleanup: { silent: files },
  chat_upload_messages: { silent: files },
  code_mode_scripts: { silent: run },
  mcp_servers: {
    silent: "A connection: the MCP runtime's change feed (mcp/change-feed.ts) tells its state."
  },
  permission_rules: { tell: "permission", id: "{row}.rule_id" },
  permission_settings: { tell: "permission", id: "{row}.singleton_id" },
  capability_offers: { silent: "A connection card in its chat, told by that chat's stream." },
  space_review_checkpoints: { silent: internal },
  space_chat_links: { tell: "space", id: "{row}.space_id" },
  space_conversations: { tell: "space", id: "{row}.space_id" },
  chat_summaries: { silent: "Read into the model's prompts; no screen shows it live." },
  space_summaries: { tell: "space", id: "{row}.space_id" },
  communication_sequence_clock: { silent: internal },
  space_continuity_seen: { silent: internal },
  run_endings: { silent: delivered },
  entity_events: { silent: "Told as record_told by its writer (entity-events.ts)." },
  run_tells: { silent: delivered },
  focus_choices: { tell: "focus_choice", id: "{row}.question_id", scope: "{row}.space_id" },
  permission_offers: { tell: "permission", id: "{row}.question_id" },
  task_contract_lines: { tell: "task", id: "{row}.item_id" },
  task_contract_proposals: { tell: "task", id: "{row}.item_id" },
  paired_devices: { silent: ownSetting },
  relay_commands: { silent: internal },
  relay_push_notified: { silent: internal },
  data_backfills: { silent: "Settings › Storage reads backfill progress while it is open." },
  connection_items: { silent: pipeline },
  connection_threads: { silent: pipeline },
  connection_cursors: { silent: pipeline },
  connection_item_threads: { silent: pipeline },
  task_proposals: { tell: "proposal", id: "{row}.proposal_id", scope: "{row}.space_id" },
  space_task_mutation_links: { silent: history },
  task_proposal_mutation_links: { silent: history },
  space_task_revisions: { silent: history },
  task_proposal_revisions: { silent: history },
  space_mutation_links: { silent: history },
  session_mutation_links: { silent: history },
  automation_configuration_mutation_links: { silent: history },
  space_revisions: { silent: history },
  session_revisions: { silent: history },
  automation_configuration_revisions: { silent: history },
  session_membership_changes: { silent: history },
  permission_changes: { silent: history },
  question_decisions: { silent: history },
  tool_approval_decisions: { silent: history },
  space_overview_revisions: { silent: history }
} as const satisfies Record<SchemaTable, TableTell>
