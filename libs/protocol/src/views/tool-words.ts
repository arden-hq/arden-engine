/**
 * What a tool NAME alone says about itself, in the words a reader sees: its
 * verb, glyph and grouping noun. One registry for every surface that names a
 * call — the desktop trail and the phone's fold lines read the same entries.
 */

/** Semantic icon key for a step — mapped to a lucide glyph in the trace row. */
export type StepIconKey =
  | "search"
  | "globe"
  | "file"
  | "edit"
  | "file-plus"
  | "folder"
  | "terminal"
  | "brain"
  | "book"
  | "list"
  | "mail"
  | "slack"
  | "calendar"
  | "clock"
  | "bell"
  | "image"
  | "wrench"
  | "history"
  | "table"
  | "app"
  | "browser"
  | "dot"

interface ToolMeta {
  activity?: "internal"
  verb: VerbPhrase | "Step"
  icon: StepIconKey
  noun?: string
  many?: VerbPhrase
}

/** The vocabulary entry a send the user kept with Save as draft on its card
 *  reads with: it says a draft was saved, not that mail was sent. */
export const SAVED_DRAFT_WORDS = "email_draft"

const TOOL_META: Record<string, ToolMeta> = {
  file_read: { verb: "Read", icon: "file", noun: "file" },
  file_write: { verb: "Wrote", icon: "file-plus", noun: "file" },
  file_edit: { verb: "Edited", icon: "edit", noun: "file" },
  file_list: { verb: "Listed files", icon: "folder" },
  file_find: { verb: "Found files", icon: "search" },
  file_search_text: { verb: "Searched code", icon: "search" },
  bash: { verb: "Ran", icon: "terminal", noun: "command" },
  exec_command: { verb: "Ran", icon: "terminal", noun: "command" },
  write_stdin: { verb: "Checked a running command", icon: "terminal" },
  code_mode: { verb: "Ran code", icon: "terminal" },
  code_mode_phase: { verb: "Step", icon: "list" },
  spawn_agent: { verb: "Started an agent", icon: "dot", noun: "agent", activity: "internal" },
  dynamic_workflow: { verb: "Ran a workflow", icon: "list", noun: "workflow" },
  current_time: { verb: "Checked the time", icon: "clock" },
  visualize: { verb: "Created a visual", icon: "image", noun: "visual" },
  load_tools: { verb: "Loaded tools", icon: "wrench" },
  tool_search: { verb: "Looked for tools", icon: "search" },
  skill: { verb: "Loaded a skill", icon: "wrench", noun: "skill" },
  playbook: { verb: "Loaded a playbook", icon: "wrench", noun: "playbook" },
  notify: { verb: "Notified you", icon: "bell" },
  todo_update: { verb: "Updated the plan", icon: "list" },

  web_search: { verb: "Searched the web", icon: "globe" },
  web_fetch: { verb: "Fetched a page", icon: "globe", noun: "page" },

  email_search: { verb: "Searched email", icon: "mail" },
  email_thread_search: { verb: "Searched email threads", icon: "mail" },
  email_read: { verb: "Read an email", icon: "mail", noun: "email" },
  email_thread_read: { verb: "Read an email thread", icon: "mail", noun: "email thread" },
  email_send: { verb: "Sent an email", icon: "mail" },
  email_reply: { verb: "Replied to an email", icon: "mail" },
  email_draft: { verb: "Saved an email draft", icon: "mail" },
  email_label_list: { verb: "Listed Gmail labels", icon: "mail" },
  email_update: { verb: "Updated email", icon: "mail" },
  email_trash: { verb: "Moved email to Trash", icon: "mail" },
  email_forward: { verb: "Sent an email forward", icon: "mail" },
  email_attachment_save: { verb: "Saved an email attachment", icon: "mail" },
  email_unsubscribe: { verb: "Updated an email subscription", icon: "mail" },

  slack_search: { verb: "Searched Slack", icon: "slack" },
  slack_channel: { verb: "Read a Slack channel", icon: "slack" },
  slack_channels: { verb: "Listed Slack channels", icon: "slack" },
  slack_dm: { verb: "Read a Slack DM", icon: "slack" },
  slack_dms: { verb: "Listed Slack DMs", icon: "slack" },
  slack_thread: { verb: "Read a Slack thread", icon: "slack" },
  slack_user: { verb: "Looked up a Slack user", icon: "slack" },
  slack_users: { verb: "Searched Slack users", icon: "slack" },
  slack_file: { verb: "Fetched a Slack file", icon: "image" },
  slack_post_message: { verb: "Posted to Slack", icon: "slack" },
  slack_post_blocks: { verb: "Posted to Slack", icon: "slack" },

  calendar_search: { verb: "Checked the calendar", icon: "calendar" },
  calendar_create_event: { verb: "Created an event", icon: "calendar" },
  calendar_edit_event: { verb: "Edited an event", icon: "calendar" },
  calendar_delete_event: { verb: "Deleted an event", icon: "calendar" },
  calendar_respond: { verb: "Replied to an invitation", icon: "calendar" },
  calendar_list_calendars: { verb: "Listed calendars", icon: "calendar" },
  calendar_free_busy: { verb: "Checked when calendars are busy", icon: "calendar" },

  wiki_search: { verb: "Searched memory", icon: "book" },
  wiki_read_page: { verb: "Read a page", icon: "book", noun: "page" },
  wiki_list_pages: { verb: "Listed pages", icon: "book" },
  wiki_links: { verb: "Read memory links", icon: "book" },
  wiki_page_history: { verb: "Read a page's history", icon: "book" },
  wiki_list_changes: { verb: "Listed memory changes", icon: "book" },
  wiki_list_collections: { verb: "Listed memory collections", icon: "book" },
  wiki_create_page: { verb: "Saved to memory", icon: "brain" },
  wiki_edit_page: { verb: "Edited memory", icon: "brain" },
  wiki_patch_page: { verb: "Edited memory", icon: "brain" },
  wiki_apply_patch_set: { verb: "Edited memory", icon: "brain" },
  wiki_archive_page: {
    verb: "Archived a memory page",
    icon: "brain",
    many: "Archived memory pages"
  },
  wiki_move_page: { verb: "Moved a memory page", icon: "brain", many: "Moved memory pages" },
  wiki_restore_page: {
    verb: "Restored a memory page",
    icon: "brain",
    many: "Restored memory pages"
  },
  wiki_create_directory: {
    verb: "Created a memory folder",
    icon: "brain",
    many: "Created memory folders"
  },
  wiki_configure_reports: { verb: "Set up memory reports", icon: "brain" },
  wiki_publish_report: {
    verb: "Published a memory report",
    icon: "brain",
    many: "Published memory reports"
  },

  session_search_transcripts: { verb: "Searched transcripts", icon: "history" },
  session_read: { verb: "Read a chat", icon: "history" },
  session_list: { verb: "Listed chats", icon: "history" },

  automation_blocked: { verb: "Reported a blocker", icon: "clock" },
  automation_create: { verb: "Created an automation", icon: "clock", many: "Created automations" },
  automation_update: { verb: "Updated an automation", icon: "clock", many: "Updated automations" },
  automation_delete: { verb: "Deleted an automation", icon: "clock", many: "Deleted automations" },
  automation_list: { verb: "Listed automations", icon: "clock" },
  automation_list_runs: { verb: "Listed automation runs", icon: "clock" },
  automation_run: { verb: "Ran an automation", icon: "clock", many: "Ran automations" },
  automation_diagnose: {
    verb: "Checked an automation",
    icon: "clock",
    many: "Checked automations"
  },

  agent_message: {
    verb: "Messaged an agent",
    icon: "dot",
    many: "Messaged agents",
    activity: "internal"
  },
  forward_message: { verb: "Forwarded a message", icon: "dot", many: "Forwarded messages" },
  report: { verb: "Reported back", icon: "dot" },
  run_inspect: { verb: "Checked a run", icon: "dot", many: "Checked runs" },
  run_no_change: { verb: "Reported no change", icon: "dot" },
  workflow_get: { verb: "Checked a workflow", icon: "list", many: "Checked workflows" },
  workflow_retry: { verb: "Retried a workflow", icon: "list", many: "Retried workflows" },
  workflow_cancel: { verb: "Stopped a workflow", icon: "list", many: "Stopped workflows" },
  goal_get: { verb: "Checked the goal", icon: "list" },
  goal_create: { verb: "Set a goal", icon: "list", many: "Set goals" },
  goal_update: { verb: "Updated the goal", icon: "list" },
  goal_complete: { verb: "Completed the goal", icon: "list" },
  goal_block: { verb: "Marked the goal blocked", icon: "list" },
  claim_record: { verb: "Recorded a claim", icon: "list", many: "Recorded claims" },
  claim_check: { verb: "Checked claims", icon: "list" },
  claim_review: { verb: "Reviewed claims", icon: "list" },
  evidence_record: { verb: "Recorded evidence", icon: "list" },

  session_send_message: {
    verb: "Sent a message to a chat",
    icon: "dot",
    many: "Sent messages to chats"
  },
  session_create: { verb: "Started a chat", icon: "dot", many: "Started chats" },
  session_rename: { verb: "Renamed a chat", icon: "dot", many: "Renamed chats" },
  session_archive: { verb: "Archived chats", icon: "dot" },
  session_move: { verb: "Moved a chat", icon: "dot", many: "Moved chats" },
  set_chat_summary: { verb: "Saved the chat summary", icon: "dot" },

  space_list: { verb: "Listed Spaces", icon: "list" },
  space_create: { verb: "Created a Space", icon: "list", many: "Created Spaces" },
  space_board_read: { verb: "Read the Space board", icon: "list" },
  space_page_read: { verb: "Read a Space page", icon: "list", many: "Read Space pages" },
  space_page_create: { verb: "Wrote a Space page", icon: "list", many: "Wrote Space pages" },
  space_page_write: { verb: "Wrote a Space page", icon: "list", many: "Wrote Space pages" },
  space_page_patch: { verb: "Edited a Space page", icon: "list", many: "Edited Space pages" },
  space_settings_update: { verb: "Updated Space settings", icon: "list" },
  space_archive: { verb: "Archived a Space", icon: "list", many: "Archived Spaces" },
  task_get: { verb: "Checked a Task", icon: "list", many: "Checked Tasks" },
  task_start: { verb: "Started a Task", icon: "list", many: "Started Tasks" },
  task_update: { verb: "Updated a Task", icon: "list", many: "Updated Tasks" },
  task_wait: { verb: "Set a Task to wait", icon: "list", many: "Set Tasks to wait" },
  task_finish: { verb: "Finished a Task", icon: "list", many: "Finished Tasks" },
  task_comment: { verb: "Commented on a Task", icon: "list", many: "Commented on Tasks" },
  task_follow: { verb: "Followed a Task here", icon: "list", many: "Followed Tasks here" },
  task_move_here: { verb: "Moved a Task here", icon: "list", many: "Moved Tasks here" },
  task_save_result: { verb: "Saved a Task report", icon: "list", many: "Saved Task reports" },
  task_propose: { verb: "Proposed a Task", icon: "list", many: "Proposed Tasks" },
  task_undo: { verb: "Undid a proposed Task", icon: "list", many: "Undid proposed Tasks" },
  space_task_create: { verb: "Created a Task", icon: "list", many: "Created Tasks" },
  space_task_update: { verb: "Updated a Task", icon: "list", many: "Updated Tasks" },
  space_task_comment: { verb: "Commented on a Task", icon: "list", many: "Commented on Tasks" },
  space_task_follow: { verb: "Followed a Task here", icon: "list", many: "Followed Tasks here" },
  space_task_save_result: { verb: "Saved a Task report", icon: "list", many: "Saved Task reports" },
  space_task_infer: { verb: "Proposed a Task", icon: "list", many: "Proposed Tasks" },
  space_task_undo: { verb: "Undid a proposed Task", icon: "list", many: "Undid proposed Tasks" },
  space_inference_review: { verb: "Reviewed proposed work", icon: "list" },
  space_review_finish: { verb: "Finished a Space review", icon: "list" },

  skill_list: { verb: "Listed skills", icon: "wrench" },
  skill_create: { verb: "Created a skill", icon: "wrench", many: "Created skills" },
  skill_update: { verb: "Updated a skill", icon: "wrench", many: "Updated skills" },
  directives_get: { verb: "Read your directives", icon: "list" },
  directives_set: { verb: "Updated your directives", icon: "list" },
  usage_limits: { verb: "Checked plan limits", icon: "clock" },
  usage_report: { verb: "Read usage", icon: "clock" },
  model_catalog: { verb: "Listed models", icon: "wrench" },
  google_accounts_list: { verb: "Listed Google accounts", icon: "wrench" },
  capability_propose: {
    verb: "Proposed a capability",
    icon: "wrench",
    many: "Proposed capabilities"
  },
  app_open: { verb: "Opened it in Arden", icon: "dot" },
  artifact_save: { verb: "Saved an artifact", icon: "dot", many: "Saved artifacts" },
  artifact_export: { verb: "Exported an artifact", icon: "dot", many: "Exported artifacts" },
  artifact_delete: { verb: "Deleted an artifact", icon: "dot", many: "Deleted artifacts" },

  browser_open: { verb: "Opened a page", icon: "browser", many: "Opened pages" },
  browser_act: { verb: "Used the browser", icon: "browser" },
  browser_upload: { verb: "Uploaded a file", icon: "browser", many: "Uploaded files" },
  browser_permission: { verb: "Set a site permission", icon: "browser" },
  browser_ask_secret: { verb: "Saved a site password", icon: "browser" },
  browser_snapshot: { verb: "Read the page", icon: "browser", many: "Read pages" },
  browser_screenshot: { verb: "Took a screenshot", icon: "image", many: "Took screenshots" },
  browser_tabs: { verb: "Checked browser tabs", icon: "browser" },
  browser_wait: { verb: "Waited for the page", icon: "browser" },
  browser_task: { verb: "Worked through the page", icon: "browser" },
  browser_close: { verb: "Closed a tab", icon: "browser", many: "Closed tabs" },

  drive_search: { verb: "Searched Google Drive", icon: "search" },
  drive_read_doc: { verb: "Read a Google Doc", icon: "file", many: "Read Google Docs" },
  drive_read_sheet: { verb: "Read a Google Sheet", icon: "table", many: "Read Google Sheets" },
  drive_list_doc_tabs: { verb: "Listed doc tabs", icon: "file" },
  drive_create_doc: {
    verb: "Created a Google Doc",
    icon: "file-plus",
    many: "Created Google Docs"
  },
  drive_create_sheet: {
    verb: "Created a Google Sheet",
    icon: "file-plus",
    many: "Created Google Sheets"
  },
  drive_edit_doc: { verb: "Edited a Google Doc", icon: "edit", many: "Edited Google Docs" },

  browser_history_summary: { verb: "Read browser history", icon: "clock" },
  agent_knowledge_scan: { verb: "Looked for notes from other assistants", icon: "search" },
  agent_knowledge_import: { verb: "Imported notes", icon: "brain" },
  agent_knowledge_digest: { verb: "Read notes from other assistants", icon: "brain" },
  approval_mode_set: { verb: "Set how I ask", icon: "wrench" },
  show_tour: { verb: "Showed you around", icon: "dot" },
  google_client_import: { verb: "Saved your Google key", icon: "wrench" }
}

/** `ask_user`: its question card is the call's visible result, drawn by the
 *  transcript on its own, so the trail neither draws nor counts the call. */
export function isAskCall(kind: string | undefined): boolean {
  return kind?.toLowerCase() === "ask_user"
}

export function isPublicActivityTool({
  name,
  presentation
}: {
  name: string
  presentation?: "work" | "conversation" | "status" | undefined
}): boolean {
  return presentation !== "status" && toolMeta(name)?.activity !== "internal"
}

/** The registry entry for a tool name, if the tool is one the app knows. The
 *  trail summary uses this to decide whether a group can speak in the tool's
 *  own words or falls back to "Called tools". */
export function toolMeta(kind: string | undefined): ToolMeta | undefined {
  return kind ? TOOL_META[kind.toLowerCase()] : undefined
}

const PREFIX_ICON: ReadonlyArray<readonly [RegExp, StepIconKey]> = [
  [/^slack_/, "slack"],
  [/^calendar_/, "calendar"],
  [/^wiki_/, "book"],
  [/^web_/, "globe"],
  [/^email_/, "mail"],
  [/^session_/, "history"],
  [/^automation_|^loop_|cron/, "clock"],
  [/^skill_/, "wrench"],
  [/notif/, "bell"],
  [/^todo_|^focus_|^directives_/, "list"],
  [/^computer_/, "app"],
  [/^browser_/, "browser"]
]

const VERB_RULES: ReadonlyArray<readonly [RegExp, string, StepIconKey]> = [
  [/\bsearch\b|\bgrep\b|\bfind\b/, "Searched", "search"],
  [/\bfetch\b|\bcurl\b|\bhttp\b|\bget\b/, "Fetched", "globe"],
  [/\bread\b|\bcat\b|\bview\b/, "Read", "file"],
  [/\bwrite\b|\bcreate\b|\bsave\b/, "Wrote", "file-plus"],
  [/\bedit\b|\breplace\b|\bpatch\b|\bupdate\b/, "Edited", "edit"],
  [/\blist\b|\bls\b/, "Listed", "folder"],
  [/\brun\b|\bexec\b|\bbash\b/, "Ran", "terminal"]
]

function humanize(s: string | undefined): string | null {
  if (!s) return null
  const spaced = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
  if (!spaced) return null
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** The step glyph for a progress sentence with no tool record behind it — the
 *  Task peek's live line only has the worker's words. Same verb heuristic the
 *  rail falls back to, so the two surfaces agree. Null = no verb recognised. */
export function iconKeyForText(text: string): StepIconKey | null {
  const norm = text.toLowerCase()
  if (/\b(mail|inbox|email|thread)\b/.test(norm)) return "mail"
  if (/\b(transcript|session|history)\b/.test(norm)) return "history"
  return VERB_RULES.find(([re]) => re.test(norm))?.[2] ?? null
}

function toolMetaFor(toolName: string | undefined): {
  meta: ToolMeta | undefined
  prefixIcon: StepIconKey | undefined
  heuristic: (typeof VERB_RULES)[number] | undefined
} {
  const name = (toolName ?? "").toLowerCase()
  const norm = name.replace(/[^a-z0-9]+/g, " ").trim()
  return {
    meta: TOOL_META[name],
    prefixIcon: PREFIX_ICON.find(([re]) => re.test(name))?.[1],
    heuristic: VERB_RULES.find(([re]) => re.test(norm))
  }
}

function iconFrom(lookup: ReturnType<typeof toolMetaFor>): StepIconKey {
  return lookup.meta?.icon ?? lookup.prefixIcon ?? lookup.heuristic?.[2] ?? "dot"
}

/** A tool's own verb, glyph and grouping noun from its name, then its
 *  display name, then its name's shape. */
export function toolKindLabel(tool: {
  readonly name: string | undefined
  readonly displayName: string | undefined
}): { verb: string; iconKey: StepIconKey; noun: string | null } {
  const lookup = toolMetaFor(tool.name)
  return {
    verb:
      lookup.meta?.verb ??
      humanize(tool.displayName) ??
      lookup.heuristic?.[1] ??
      humanize(tool.name) ??
      "Tool",
    iconKey: iconFrom(lookup),
    noun: lookup.meta?.noun ?? null
  }
}

/** What the reader calls a tool the app has no verb for: its own display
 *  name, or its name — never a bare "a tool". */
export function namedTool(tool: {
  readonly name: string | undefined
  readonly displayName: string | undefined
}): string {
  return humanize(tool.displayName) ?? humanize(tool.name) ?? "a tool"
}

/** The category glyph for a tool NAME alone — the one mapping every surface
 *  that draws a tool reads: the trace row through {@link operationKindLabel},
 *  and the held effect in the Task peek, which only has the approval's
 *  `tool_name`. */
export function iconKeyForToolName(toolName: string | undefined): StepIconKey {
  return iconFrom(toolMetaFor(toolName))
}

const VERB_FORMS = {
  Added: { waiting: "Add", running: "Adding" },
  Archived: { waiting: "Archive", running: "Archiving" },
  Changed: { waiting: "Change", running: "Changing" },
  Checked: { waiting: "Check", running: "Checking" },
  Closed: { waiting: "Close", running: "Closing" },
  Commented: { waiting: "Comment", running: "Commenting" },
  Completed: { waiting: "Complete", running: "Completing" },
  Connected: { waiting: "Connect", running: "Connecting" },
  Created: { waiting: "Create", running: "Creating" },
  Deleted: { waiting: "Delete", running: "Deleting" },
  Downloaded: { waiting: "Download", running: "Downloading" },
  Edited: { waiting: "Edit", running: "Editing" },
  Exported: { waiting: "Export", running: "Exporting" },
  Fetched: { waiting: "Fetch", running: "Fetching" },
  Finished: { waiting: "Finish", running: "Finishing" },
  Followed: { waiting: "Follow", running: "Following" },
  Forwarded: { waiting: "Forward", running: "Forwarding" },
  Found: { waiting: "Find", running: "Finding" },
  Imported: { waiting: "Import", running: "Importing" },
  Installed: { waiting: "Install", running: "Installing" },
  Listed: { waiting: "List", running: "Listing" },
  Loaded: { waiting: "Load", running: "Loading" },
  Looked: { waiting: "Look", running: "Looking" },
  Marked: { waiting: "Mark", running: "Marking" },
  Messaged: { waiting: "Message", running: "Messaging" },
  Moved: { waiting: "Move", running: "Moving" },
  Notified: { waiting: "Notify", running: "Notifying" },
  Opened: { waiting: "Open", running: "Opening" },
  Posted: { waiting: "Post", running: "Posting" },
  Proposed: { waiting: "Propose", running: "Proposing" },
  Published: { waiting: "Publish", running: "Publishing" },
  Ran: { waiting: "Run", running: "Running" },
  Read: { waiting: "Read", running: "Reading" },
  Recorded: { waiting: "Record", running: "Recording" },
  Removed: { waiting: "Remove", running: "Removing" },
  Renamed: { waiting: "Rename", running: "Renaming" },
  Replied: { waiting: "Reply", running: "Replying" },
  Reported: { waiting: "Report", running: "Reporting" },
  Restored: { waiting: "Restore", running: "Restoring" },
  Retried: { waiting: "Retry", running: "Retrying" },
  Returned: { waiting: "Return", running: "Returning" },
  Reviewed: { waiting: "Review", running: "Reviewing" },
  Saved: { waiting: "Save", running: "Saving" },
  Scheduled: { waiting: "Schedule", running: "Scheduling" },
  Searched: { waiting: "Search", running: "Searching" },
  Sent: { waiting: "Send", running: "Sending" },
  Set: { waiting: "Set", running: "Setting" },
  Showed: { waiting: "Show", running: "Showing" },
  Started: { waiting: "Start", running: "Starting" },
  Stopped: { waiting: "Stop", running: "Stopping" },
  Took: { waiting: "Take", running: "Taking" },
  Undid: { waiting: "Undo", running: "Undoing" },
  Updated: { waiting: "Update", running: "Updating" },
  Uploaded: { waiting: "Upload", running: "Uploading" },
  Used: { waiting: "Use", running: "Using" },
  Waited: { waiting: "Wait", running: "Waiting" },
  Worked: { waiting: "Work", running: "Working" },
  Wrote: { waiting: "Write", running: "Writing" }
} as const satisfies Readonly<
  Record<string, { readonly waiting: string; readonly running: string }>
>

type PastVerb = keyof typeof VERB_FORMS

type VerbPhrase = PastVerb | `${PastVerb} ${string}`

function verbIn(verb: string, state: "waiting" | "running"): string {
  const space = verb.indexOf(" ")
  const head = space < 0 ? verb : verb.slice(0, space)
  if (!isPastVerb(head)) return verb
  const form = VERB_FORMS[head][state]
  return space < 0 ? form : `${form}${verb.slice(space)}`
}

const isPastVerb = (word: string): word is PastVerb => Object.hasOwn(VERB_FORMS, word)

/** A call waiting on your answer: it has not happened yet. */
export function waitingVerb(verb: string): string {
  return verbIn(verb, "waiting")
}

/** A call that failed says so in words, not only in a glyph: "Read" becomes
 *  "Failed to read", "Ran a command" becomes "Failed to run a command". Words
 *  that open with no known verb (a model's own title, a tool's display name)
 *  are kept as written, the glyph and ink still marking the failure. */
export function failedVerb(verb: string): string {
  const waiting = verbIn(verb, "waiting")
  if (waiting === verb && !isPastVerb(verb.split(" ", 1)[0] ?? "")) return verb
  return `Failed to ${waiting.charAt(0).toLowerCase()}${waiting.slice(1)}`
}

/** A call still running: it is happening now ("Searched the web" →
 *  "Searching the web"). Settled calls keep the done words. */
export function runningVerb(verb: string): string {
  return verbIn(verb, "running")
}
