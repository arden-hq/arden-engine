import type { ToolEntry, ToolInputSource } from "@arden-hq/loop"
import { Predicate } from "effect"

import type { ToolScopeKey } from "../execution/policy.js"
import { AGENT_MODE } from "@arden-hq/protocol/chat"
import { ACTOR, type RunAuthority } from "../execution/authority.js"
import { refusalPath } from "../execution/decide.js"
import { renderRefusal } from "../execution/refusal.js"
import { parseMcpSource } from "../mcp/naming.js"
import { ALWAYS_LOADED, discoveryOf, type ServerTool, type ServerToolMetadata } from "./define.js"
import { scopedRunToolNames } from "./tool-scopes.js"
import { toolParametersJsonSchema } from "./tool-json-schema.js"
import type { SpecialChat } from "../context/special-chat.js"

export interface ChatPreload {
  readonly tools: ReadonlyArray<string>
  readonly groups: ReadonlyArray<string>
}

export const SPECIAL_CHAT_PRELOAD: Readonly<Record<SpecialChat["kind"], ChatPreload>> = {
  capture: { tools: ["forward_message", "session_list", "session_move"], groups: [] },
  onboarding: {
    tools: [
      "ask_user",
      "skill",
      "wiki_read_page",
      "wiki_create_page",
      "wiki_edit_page",
      "directives_get",
      "directives_set"
    ],
    groups: ["onboarding"]
  }
}

export const SPACE_CHAT_PRELOAD: ChatPreload = {
  tools: [],
  groups: ["space", "tasks", "task_inference"]
}

const groupOf = (tool: ServerTool): string | undefined => {
  const discovery = discoveryOf(tool.definition)
  return discovery === undefined || discovery === ALWAYS_LOADED ? undefined : discovery.group
}

export const preloadToolNames = (
  tools: ReadonlyArray<ServerTool>,
  preload: ChatPreload
): ReadonlyArray<string> => [
  ...preload.tools,
  ...preload.groups.flatMap((group) =>
    tools.filter((tool) => groupOf(tool) === group).map((tool) => tool.definition.name)
  )
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
  vault_use_key: inputs(["name", "vault_list"]),
  vault_pay: inputs(
    ["card_id", "vault_list"],
    ["tab_ref", "browser_tabs"],
    ["shop", "browser_tabs"]
  ),
  vault_allow_payment_frame: inputs(["card_id", "vault_list"], ["frame", "vault_checkout"]),
  vault_checkout: inputs(
    ["card_id", "vault_list"],
    ["tab_ref", "browser_snapshot"],
    ["snapshot_ref", "browser_snapshot"]
  ),
  browser_ask_secret: inputs(
    ["tab_ref", "browser_tabs", "browser_snapshot"],
    ["origin", "browser_tabs", "browser_snapshot"]
  ),
  artifact_export: inputs([
    "artifact_ref",
    "artifact_save",
    "browser_screenshot",
    "exec_command",
    "chat_files_list"
  ]),
  artifact_delete: inputs(["refs", "artifact_save", "browser_screenshot", "exec_command"]),
  skill_update: inputs(["name", "skill"]),
  wiki_edit_page: inputs(["path", "wiki_search", "wiki_read_page"]),
  wiki_patch_page: inputs(["path", "wiki_search"], ["old_text", "wiki_read_page"]),
  wiki_page_history: inputs(["path", "wiki_search"], ["line", "wiki_read_page"]),
  wiki_links: inputs(["path", "wiki_search"]),
  wiki_archive_page: inputs(["path", "wiki_search"]),
  wiki_merge_page: inputs(["path", "wiki_search"], ["into", "wiki_search"]),
  wiki_move_page: inputs(["path", "wiki_search"]),
  wiki_restore_page: inputs(["path", "wiki_search"], ["at", "wiki_page_history"]),
  space_page_patch: inputs(["old_text", "space_page_read"]),
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
  wiki_read_change: inputs(["page", "wiki_search", "wiki_list_changes"]),
  calendar_delete_event: inputs(["event_ref", "calendar_search"]),
  calendar_respond: inputs(["event_ref", "calendar_search"]),
  calendar_create_event: inputs(
    ["account_ref", "google_accounts_list"],
    ["attachments", "drive_search", "drive_upload"]
  ),
  mac_calendar_search: inputs(["calendar_ids", "mac_calendar_list_calendars"]),
  mac_calendar_read_event: inputs([
    "event_ref",
    "mac_calendar_search",
    "mac_calendar_create_event",
    "mac_calendar_edit_event"
  ]),
  mac_calendar_create_event: inputs(["calendar_id", "mac_calendar_list_calendars"]),
  mac_calendar_edit_event: inputs(
    ["event_ref", "mac_calendar_search", "mac_calendar_create_event", "mac_calendar_edit_event"],
    ["calendar_id", "mac_calendar_list_calendars"]
  ),
  mac_calendar_delete_event: inputs([
    "event_ref",
    "mac_calendar_search",
    "mac_calendar_create_event",
    "mac_calendar_edit_event"
  ]),
  mac_reminders_search: inputs(["list_ids", "mac_reminders_list_lists"]),
  mac_reminders_create: inputs(["list_id", "mac_reminders_list_lists"]),
  mac_reminders_edit: inputs(
    ["reminder_ref", "mac_reminders_search", "mac_reminders_create"],
    ["list_id", "mac_reminders_list_lists"]
  ),
  mac_reminders_complete: inputs(["reminder_ref", "mac_reminders_search", "mac_reminders_create"]),
  mac_reminders_delete: inputs(["reminder_ref", "mac_reminders_search", "mac_reminders_create"]),
  mac_contacts_read: inputs(["contact_ref", "mac_contacts_search"]),
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

export const catalogNameProblems = (tools: ReadonlyArray<ServerTool>): ReadonlyArray<string> => {
  const params = new Map(
    tools.map((tool) => [tool.definition.name, topLevelParameters(tool)] as const)
  )
  const unknown = (where: string) => (name: string) =>
    params.has(name) ? [] : [`${where} names ${name}, which is not a built-in tool`]
  const groups = new Set(tools.map(groupOf))
  const unknownGroup = (where: string) => (group: string) =>
    groups.has(group) ? [] : [`${where} names group ${group}, which no built-in tool has`]
  return [
    ...Object.entries(SPECIAL_CHAT_PRELOAD).flatMap(([kind, preload]) => [
      ...preload.tools.flatMap(unknown(`SPECIAL_CHAT_PRELOAD.${kind}`)),
      ...preload.groups.flatMap(unknownGroup(`SPECIAL_CHAT_PRELOAD.${kind}`))
    ]),
    ...SPACE_CHAT_PRELOAD.groups.flatMap(unknownGroup("SPACE_CHAT_PRELOAD")),
    ...Object.entries(INPUT_SOURCES).flatMap(([name, sources]) => [
      ...unknown("INPUT_SOURCES")(name),
      ...sources.flatMap((source) => [
        ...(params.get(name)?.has(source.input) === false
          ? [`INPUT_SOURCES.${name} names input ${source.input}, which ${name} does not take`]
          : []),
        ...source.tools.flatMap(unknown(`INPUT_SOURCES.${name}.${source.input}`))
      ])
    ])
  ]
}

const topLevelParameters = (tool: ServerTool): ReadonlySet<string> => {
  const properties = tool.entry(toolParametersJsonSchema).parameters["properties"]
  return new Set(Predicate.isObject(properties) ? Object.keys(properties) : [])
}

export const treeToolNames = (
  tools: ReadonlyArray<ServerTool>,
  scopes: Record<ToolScopeKey, ReadonlySet<string>>
): ReadonlySet<string> =>
  new Set([
    ...scopedRunToolNames(tools, scopes, "all", [], { kind: "tree" }),
    ...tools.filter((tool) => groupOf(tool) !== undefined).map((tool) => tool.definition.name)
  ])

export const ownedToolNames = (
  tools: ReadonlyArray<ServerTool>,
  scopes: ReadonlyArray<ToolScopeKey>
): ReadonlyArray<string> =>
  tools
    .filter(
      (tool) =>
        tool.meta.invocation_only !== true &&
        discoveryOf(tool.definition) !== ALWAYS_LOADED &&
        ownedByScopes(tool.meta, scopes)
    )
    .map((tool) => tool.definition.name)

const REFUSAL_REASON = { scope: "scope", denied: "denied" } as const

type RefusalReason = (typeof REFUSAL_REASON)[keyof typeof REFUSAL_REASON]

export const refusalText =
  (authority: RunAuthority): ((name: string, reason: RefusalReason) => string) =>
  (name: string, reason: RefusalReason): string => {
    if (reason === REFUSAL_REASON.denied)
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
  if (actor.kind !== ACTOR.agent) return "outside what this run may use"
  switch (actor.mode) {
    case AGENT_MODE.research:
      return "not available to research agents: they read and research only"
    case AGENT_MODE.code:
      return "not available to code agents: they work with files, the shell and code in their own folder"
    case AGENT_MODE.work:
      return "outside what this agent may use"
  }
}

const BROAD_SCOPES: ReadonlySet<ToolScopeKey> = new Set(["all", "space"])
const OUTCOME_RUN_SCOPES: ReadonlySet<ToolScopeKey> = new Set(["worker", "observer"])

export const applyToolCatalog = (
  entries: ReadonlyArray<ToolEntry>,
  context: {
    readonly scopes: ReadonlyArray<ToolScopeKey>
    readonly tools: ReadonlyMap<string, ServerTool>
  }
): ReadonlyArray<ToolEntry> => {
  const visible = entries.filter(
    (entry) => context.tools.get(entry.meta.name)?.meta.invocation_only !== true
  )
  const [primary] = context.scopes
  if (primary === undefined || !BROAD_SCOPES.has(primary)) return visible
  return visible.map((entry) => {
    const name = entry.meta.name
    const tool = context.tools.get(name)
    const sources = INPUT_SOURCES[name]
    const group = toolGroup(tool)
    const deferred =
      (tool === undefined || discoveryOf(tool.definition) !== ALWAYS_LOADED) &&
      entry.meta.hosted !== true &&
      !(tool !== undefined && ownedByScopes(tool.meta, context.scopes))
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

const toolGroup = (tool: ServerTool | undefined): string | undefined => {
  const server = parseMcpSource(tool?.meta.source)?.serverName
  if (server !== undefined) return `mcp_${server.replace(/[^A-Za-z0-9_-]/g, "_")}`
  return tool === undefined ? undefined : groupOf(tool)
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
