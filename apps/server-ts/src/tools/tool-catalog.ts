import type { ToolEntry, ToolInputSource } from "@arden-hq/loop"

import type { ToolScopeKey } from "../execution/policy.js"
import type { RunAuthority } from "../execution/authority.js"
import { refusalPath } from "../execution/decide.js"
import { renderRefusal } from "../execution/refusal.js"
import { parseMcpSource } from "../mcp/naming.js"
import type { ServerTool, ServerToolMetadata } from "./define.js"
import { scopedRunToolNames } from "./tool-scopes.js"
import type { SpecialChat } from "../context/special-chat.js"

const ALWAYS_LOADED: ReadonlySet<string> = new Set([
  "exec_command",
  "write_stdin",
  "file_read",
  "file_edit",
  "file_write",
  "file_search_text",
  "file_list",
  "file_find",
  "code_mode",
  "spawn_agent",
  "agent_message",
  "session_read",
  "session_search_transcripts",
  "wiki_read_page",
  "wiki_search",
  "skill",
  "web_fetch",
  "current_time",
  "todo_update",
  "ask_user",
  "permissions_read"
])

/** Deferred tools by the job they do together. OpenAI advises fewer than 10 per namespace. */
const TOOL_GROUPS: Readonly<Record<string, ReadonlyArray<string>>> = {
  // OpenAI reserves "browser": a run that loaded this group as `browser` was
  // refused with HTTP 400 on its next request.
  computer_control: [
    "computer_repl",
    "computer_launch",
    "computer_clipboard_write",
    "computer_read",
    "computer_act",
    "computer_reset"
  ],
  web_browser: [
    "browser_open",
    "browser_tabs",
    "browser_snapshot",
    "browser_act",
    "browser_upload",
    "browser_permission",
    "browser_wait",
    "browser_screenshot",
    "browser_pointer",
    "browser_close"
  ],
  web_browser_sign_in: ["browser_ask_secret"],
  web_browser_tasks: ["browser_task", "browser_procedure"],
  space: [
    "space_list",
    "space_board_read",
    "space_page_read",
    "space_page_patch",
    "space_page_write",
    "space_page_create",
    "space_create",
    "space_settings_update",
    "space_archive"
  ],
  tasks: [
    "task_get",
    "task_start",
    "task_update",
    "task_wait",
    "task_finish",
    "task_comment",
    "task_save_result",
    "task_move_here"
  ],
  task_inference: ["task_propose", "space_inference_review"],
  task_contract: ["task_contract_propose", "task_criterion_met"],
  wiki_upkeep: [
    "wiki_list_pages",
    "wiki_list_collections",
    "wiki_links",
    "wiki_list_changes",
    "wiki_read_change",
    "wiki_page_history",
    "wiki_create_page",
    "wiki_edit_page",
    "wiki_patch_page"
  ],
  wiki_admin: [
    "wiki_archive_page",
    "wiki_move_page",
    "wiki_restore_page",
    "wiki_create_directory",
    "wiki_configure_reports",
    "wiki_publish_report"
  ],
  email: [
    "email_search",
    "email_thread_search",
    "email_read",
    "email_thread_read",
    "email_send",
    "email_reply",
    "email_forward",
    "email_draft",
    "email_attachment_save",
    "google_accounts_list"
  ],
  email_organize: ["email_label_list", "email_update", "email_trash", "email_unsubscribe"],
  calendar: [
    "calendar_search",
    "calendar_read_event",
    "calendar_create_event",
    "calendar_edit_event",
    "calendar_delete_event",
    "calendar_respond",
    "calendar_list_calendars",
    "calendar_free_busy"
  ],
  drive: [
    "drive_search",
    "drive_list_doc_tabs",
    "drive_read_doc",
    "drive_read_sheet",
    "drive_create_doc",
    "drive_edit_doc",
    "drive_create_sheet",
    "drive_update_sheet",
    "drive_append_sheet_rows"
  ],
  drive_files: ["drive_upload", "drive_download", "drive_export", "drive_share_file"],
  automations: [
    "automation_list",
    "automation_list_runs",
    "automation_diagnose",
    "automation_create",
    "automation_update",
    "automation_delete",
    "automation_run",
    "run_inspect",
    "usage_report"
  ],
  sessions: [
    "session_list",
    "session_send_message",
    "session_create",
    "session_move",
    "session_rename",
    "session_archive",
    "forward_message",
    "thread_bring_back"
  ],
  connection_items: ["connection_items_state", "connection_item_read", "item_move"],
  arden_settings: [
    "directives_get",
    "directives_set",
    "usage_limits",
    "model_catalog",
    "skill_list",
    "skill_create",
    "skill_update",
    "capability_propose",
    "app_open"
  ],
  workflows: ["workflow_get", "workflow_retry", "workflow_cancel"],
  output: [
    "artifact_save",
    "artifact_export",
    "artifact_delete",
    "answer_block_read",
    "chat_files_list"
  ],
  run_outcome: ["report", "tell", "automation_followup"],
  run_events: ["automation_run_events"],
  research: ["claim_record", "evidence_record", "claim_check", "claim_review"],
  onboarding: [
    "browser_history_summary",
    "agent_knowledge_scan",
    "agent_knowledge_import",
    "agent_knowledge_digest",
    "approval_mode_set",
    "show_tour",
    "google_client_import"
  ],
  chat_summary: ["set_chat_summary"]
}

export const SPECIAL_CHAT_PRELOAD: Readonly<Record<SpecialChat["kind"], ReadonlyArray<string>>> = {
  capture: ["forward_message", "session_list", "session_move"],
  onboarding: [
    "ask_user",
    "skill",
    "wiki_read_page",
    "wiki_create_page",
    "wiki_edit_page",
    "directives_get",
    "directives_set",
    ...(TOOL_GROUPS["onboarding"] ?? [])
  ]
}

export const SPACE_CHAT_PRELOAD: ReadonlyArray<string> = [
  ...(TOOL_GROUPS["space"] ?? []),
  ...(TOOL_GROUPS["tasks"] ?? []),
  ...(TOOL_GROUPS["task_inference"] ?? [])
]

const inputs = (
  ...sources: ReadonlyArray<readonly [input: string, ...tools: Array<string>]>
): ReadonlyArray<ToolInputSource> => sources.map(([input, ...tools]) => ({ input, tools }))

const INPUT_SOURCES: Readonly<Record<string, ReadonlyArray<ToolInputSource>>> = {
  run_inspect: inputs(
    ["run_id", "automation_list_runs", "spawn_agent"],
    ["session_ref", "session_list", "spawn_agent"]
  ),
  workflow_get: inputs(["workflow_ref", "code_mode"]),
  workflow_retry: inputs(["workflow_ref", "workflow_get"], ["expected_version", "workflow_get"]),
  workflow_cancel: inputs(["workflow_ref", "workflow_get"]),
  session_send_message: inputs(["session_ref", "session_list"]),
  session_rename: inputs(["session_ref", "session_list"]),
  forward_message: inputs(["session_ref", "session_list"]),
  session_archive: inputs(["session_refs", "session_list"]),
  session_move: inputs(["space_id", "space_list"]),
  item_move: inputs(["item_id", "connection_items_state"], ["space_id", "space_list"]),
  connection_item_read: inputs(["item_id", "connection_items_state"]),
  automation_list_runs: inputs(["automation_ref", "automation_list"]),
  automation_update: inputs(["automation_ref", "automation_list"]),
  automation_delete: inputs(["automation_ref", "automation_list"]),
  automation_run: inputs(["automation_ref", "automation_list"]),
  wiki_configure_reports: inputs(["automation_ref", "automation_create", "automation_list"]),
  browser_snapshot: inputs(["tab_ref", "browser_open", "browser_tabs"]),
  browser_screenshot: inputs(["tab_ref", "browser_open", "browser_tabs"]),
  browser_wait: inputs(["tab_ref", "browser_open", "browser_tabs"]),
  browser_procedure: inputs(["tab_ref", "browser_snapshot"], ["procedure_id", "browser_snapshot"]),
  browser_task: inputs(["tab_ref", "browser_open", "browser_tabs"]),
  browser_close: inputs(["tab_ref", "browser_open", "browser_tabs"]),
  browser_pointer: inputs(
    ["screenshot_ref", "browser_screenshot"],
    ["tab_ref", "browser_screenshot"],
    ["profile_ref", "browser_screenshot"],
    ["origin", "browser_screenshot"]
  ),
  browser_act: inputs(
    ["tab_ref", "browser_snapshot", "browser_act", "browser_upload", "browser_task"],
    ["profile_ref", "browser_snapshot", "browser_act", "browser_upload", "browser_task"],
    ["origin", "browser_snapshot", "browser_act", "browser_upload", "browser_task"],
    ["snapshot_ref", "browser_snapshot", "browser_act", "browser_upload", "browser_task"]
  ),
  browser_upload: inputs(
    ["tab_ref", "browser_snapshot", "browser_act", "browser_upload", "browser_task"],
    ["profile_ref", "browser_snapshot", "browser_act", "browser_upload", "browser_task"],
    ["origin", "browser_snapshot", "browser_act", "browser_upload", "browser_task"],
    ["snapshot_ref", "browser_snapshot", "browser_act", "browser_upload", "browser_task"]
  ),
  browser_permission: inputs(["request_ref", "browser_tabs"], ["tab_ref", "browser_tabs"]),
  browser_ask_secret: inputs(
    ["tab_ref", "browser_tabs", "browser_snapshot"],
    ["origin", "browser_tabs", "browser_snapshot"]
  ),
  artifact_export: inputs(["artifact_ref", "artifact_save", "browser_screenshot"]),
  artifact_delete: inputs(["refs", "artifact_save", "browser_screenshot"]),
  skill_update: inputs(["name", "skill"], ["expected_sha256", "skill"]),
  wiki_edit_page: inputs(["path", "wiki_search", "wiki_read_page"]),
  wiki_patch_page: inputs(["path", "wiki_search"], ["old_text", "wiki_read_page"]),
  wiki_page_history: inputs(["path", "wiki_search"]),
  wiki_links: inputs(["path", "wiki_search"]),
  wiki_archive_page: inputs(["path", "wiki_search"]),
  wiki_move_page: inputs(["path", "wiki_search"]),
  wiki_restore_page: inputs(["path", "wiki_search"], ["revision_ref", "wiki_page_history"]),
  space_page_patch: inputs(["old_text", "space_page_read"]),
  space_page_create: inputs(["space_id", "space_list"]),
  space_settings_update: inputs(["space_id", "space_list"], ["expected_updated_at", "space_list"]),
  space_archive: inputs(["space_id", "space_list"]),
  task_start: inputs(["key", "space_board_read", "task_get"]),
  task_update: inputs(
    ["key", "space_board_read", "task_get"],
    ["expected_updated_at", "space_board_read", "task_get"]
  ),
  task_wait: inputs(
    ["key", "space_board_read", "task_get"],
    ["expected_updated_at", "space_board_read", "task_get"]
  ),
  task_finish: inputs(
    ["key", "space_board_read", "task_get"],
    ["expected_updated_at", "space_board_read", "task_get"]
  ),
  task_comment: inputs(["key", "space_board_read", "task_get"]),
  task_save_result: inputs(["item_id", "space_board_read"]),
  task_move_here: inputs(["item_id", "space_board_read"]),
  task_propose: inputs(["snapshot", "space_inference_review"]),
  email_read: inputs(["message_ref", "email_search", "email_thread_read"]),
  email_reply: inputs(
    ["message_ref", "email_search", "email_thread_read"],
    ["attachments", "chat_files_list"]
  ),
  email_thread_read: inputs(["thread_ref", "email_search", "email_thread_search"]),
  email_send: inputs(["account_ref", "google_accounts_list"], ["attachments", "chat_files_list"]),
  email_draft: inputs(
    ["account_ref", "google_accounts_list"],
    ["reply_to_message_ref", "email_search", "email_thread_read"],
    ["attachments", "chat_files_list"]
  ),
  email_forward: inputs(["message_ref", "email_search", "email_thread_read"]),
  email_attachment_save: inputs(["message_ref", "email_search", "email_thread_read"]),
  email_unsubscribe: inputs(["message_ref", "email_search", "email_thread_read"]),
  email_update: inputs(
    ["account_ref", "google_accounts_list"],
    ["thread_refs", "email_thread_search", "email_search", "email_thread_read"]
  ),
  email_trash: inputs(
    ["account_ref", "google_accounts_list"],
    ["thread_refs", "email_thread_search", "email_search", "email_thread_read"]
  ),
  calendar_edit_event: inputs(
    ["event_ref", "calendar_search"],
    ["add_attachments", "drive_search", "drive_upload"]
  ),
  calendar_read_event: inputs(["event_id", "calendar_search"], ["account", "google_accounts_list"]),
  wiki_read_change: inputs(["revision", "wiki_list_changes"]),
  calendar_delete_event: inputs(["event_ref", "calendar_search"]),
  calendar_respond: inputs(["event_ref", "calendar_search"]),
  calendar_create_event: inputs(
    ["account_ref", "google_accounts_list"],
    ["attachments", "drive_search", "drive_upload"]
  ),
  drive_upload: inputs(["file", "chat_files_list"], ["account_ref", "google_accounts_list"]),
  drive_download: inputs(["file_ref", "drive_search"]),
  drive_export: inputs(["file_ref", "drive_search"]),
  drive_share_file: inputs(["file_ref", "drive_search", "drive_upload"]),
  drive_list_doc_tabs: inputs(["document_ref", "drive_search"]),
  drive_read_doc: inputs(["document_ref", "drive_search"]),
  drive_edit_doc: inputs(["document_ref", "drive_search"]),
  drive_read_sheet: inputs(["spreadsheet_ref", "drive_search"]),
  drive_update_sheet: inputs(["spreadsheet_ref", "drive_search"]),
  drive_append_sheet_rows: inputs(["spreadsheet_ref", "drive_search"]),
  drive_create_doc: inputs(["account_ref", "google_accounts_list"]),
  drive_create_sheet: inputs(["account_ref", "google_accounts_list"])
}

export const treeToolNames = (
  tools: ReadonlyArray<ServerTool>,
  scopes: Record<ToolScopeKey, ReadonlySet<string>>
): ReadonlySet<string> =>
  new Set([
    ...scopedRunToolNames(tools, scopes, "all", [], { kind: "tree" }),
    ...tools.map((tool) => tool.definition.name).filter((name) => GROUP_OF.has(name))
  ])

export const ownedToolNames = (
  tools: ReadonlyArray<ServerTool>,
  scopes: ReadonlyArray<ToolScopeKey>
): ReadonlyArray<string> =>
  tools
    .filter(
      (tool) =>
        tool.meta.invocation_only !== true &&
        !ALWAYS_LOADED.has(tool.definition.name) &&
        ownedByScopes(tool.meta, scopes)
    )
    .map((tool) => tool.definition.name)

export const refusalText =
  (authority: RunAuthority) =>
  (name: string, reason: "scope" | "denied"): string => {
    if (reason === "denied")
      return renderRefusal({
        what: `${name} is not allowed in this run: the user turned this tool off`,
        rule: "user_deny",
        instead: [{ kind: "ask_user" }]
      })
    return renderRefusal({
      what: `${name} is ${reachClause(authority.actor)}`,
      rule: "reach",
      instead: refusalPath(authority.actor)
    })
  }

const reachClause = (actor: RunAuthority["actor"]): string => {
  if (actor.kind !== "agent") return "outside what this run may use"
  switch (actor.mode) {
    case "research":
      return "not available to research agents: they read and research only"
    case "code":
      return "not available to code agents: they work with files, the shell and code in their own folder"
    case "work":
      return "outside what this agent may use"
  }
}

const BROAD_SCOPES: ReadonlySet<ToolScopeKey> = new Set(["all", "space"])
const OUTCOME_RUN_SCOPES: ReadonlySet<ToolScopeKey> = new Set(["worker", "observer"])

const GROUP_OF: ReadonlyMap<string, string> = new Map(
  Object.entries(TOOL_GROUPS).flatMap(([group, names]) => names.map((name) => [name, group]))
)

export const applyToolCatalog = (
  entries: ReadonlyArray<ToolEntry>,
  context: {
    readonly scopes: ReadonlyArray<ToolScopeKey>
    readonly metadata: ReadonlyMap<string, ServerToolMetadata>
  }
): ReadonlyArray<ToolEntry> => {
  const visible = entries.filter(
    (entry) => context.metadata.get(entry.meta.name)?.invocation_only !== true
  )
  const [primary] = context.scopes
  if (primary === undefined || !BROAD_SCOPES.has(primary)) return visible
  return visible.map((entry) => {
    const name = entry.meta.name
    const metadata = context.metadata.get(name)
    const sources = INPUT_SOURCES[name]
    const group = toolGroup(name, metadata)
    const deferred =
      !ALWAYS_LOADED.has(name) &&
      entry.meta.hosted !== true &&
      !(metadata !== undefined && ownedByScopes(metadata, context.scopes))
    return {
      ...entry,
      meta: {
        ...entry.meta,
        deferred,
        ...(group === undefined ? {} : { group }),
        ...(sources === undefined ? {} : { input_sources: sources })
      }
    }
  })
}

const toolGroup = (name: string, metadata: ServerToolMetadata | undefined): string | undefined => {
  const server = parseMcpSource(metadata?.source)?.serverName
  if (server !== undefined) return `mcp_${server.replace(/[^A-Za-z0-9_-]/g, "_")}`
  return GROUP_OF.get(name)
}

const ownedByScopes = (
  metadata: ServerToolMetadata,
  scopes: ReadonlyArray<ToolScopeKey>
): boolean =>
  scopes.some(
    (scope) =>
      metadata.scopes.includes(scope) ||
      metadata.private_scope === scope ||
      (metadata.outcome && OUTCOME_RUN_SCOPES.has(scope))
  )
