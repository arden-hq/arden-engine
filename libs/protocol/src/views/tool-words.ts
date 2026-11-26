import {
  INTERNAL_TOOLS,
  TOOL_GROUP,
  TOOL_GROUP_WORDS,
  TOOL_META,
  VIEWED_TOOL,
  type ToolMeta,
  type ToolNoun,
  type ViewedTool
} from "./tool-registry.js"
import { TOOL_PRESENTATION, type ToolPresentation } from "../chat/tool-face.js"

export const STEP_ICON = {
  search: "search",
  globe: "globe",
  file: "file",
  edit: "edit",
  filePlus: "file-plus",
  folder: "folder",
  terminal: "terminal",
  brain: "brain",
  book: "book",
  list: "list",
  mail: "mail",
  slack: "slack",
  calendar: "calendar",
  clock: "clock",
  bell: "bell",
  image: "image",
  wrench: "wrench",
  history: "history",
  table: "table",
  app: "app",
  browser: "browser",
  dot: "dot"
} as const

export type StepIconKey = (typeof STEP_ICON)[keyof typeof STEP_ICON]

export const SAVED_DRAFT_WORDS = "email_draft"

const ASK_CALLS: ReadonlySet<string> = new Set<ViewedTool>([
  VIEWED_TOOL.ask_user,
  VIEWED_TOOL.permission_offer
])

export function isAskCall(kind: string | undefined): boolean {
  return kind !== undefined && ASK_CALLS.has(kind.toLowerCase())
}

export function isPublicActivityTool(
  name: string,
  presentation: ToolPresentation | undefined
): boolean {
  return presentation !== TOOL_PRESENTATION.status && !INTERNAL_TOOLS.has(name.toLowerCase())
}

export function toolMeta(kind: string | undefined): ToolMeta | undefined {
  return kind ? TOOL_META[kind.toLowerCase()] : undefined
}

export function toolNoun(kind: string): ToolNoun | null {
  const words = TOOL_GROUP_WORDS[kind.toLowerCase()]
  return words?.kind === TOOL_GROUP.noun ? words.noun : null
}

export function toolManyWords(kind: string): VerbPhrase | undefined {
  const words = TOOL_GROUP_WORDS[kind.toLowerCase()]
  return words?.kind === TOOL_GROUP.many ? words.many : undefined
}

export interface ToolNaming {
  readonly name: string
  readonly displayName: string | null
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

function humanize(s: string | null): string | null {
  if (!s) return null
  const spaced = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
  if (!spaced) return null
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

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

export function toolKindLabel(tool: ToolNaming): {
  verb: string
  iconKey: StepIconKey
  noun: string | null
} {
  const lookup = toolMetaFor(tool.name)
  return {
    verb:
      lookup.meta?.verb ??
      humanize(tool.displayName) ??
      lookup.heuristic?.[1] ??
      humanize(tool.name) ??
      "Tool",
    iconKey: iconFrom(lookup),
    noun: toolNoun(tool.name)
  }
}

export function namedTool(tool: ToolNaming): string {
  return humanize(tool.displayName) ?? humanize(tool.name) ?? "a tool"
}

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

export type VerbPhrase = PastVerb | `${PastVerb} ${string}`

function verbIn(verb: string, state: "waiting" | "running"): string {
  const space = verb.indexOf(" ")
  const head = space < 0 ? verb : verb.slice(0, space)
  if (!isPastVerb(head)) return verb
  const form = VERB_FORMS[head][state]
  return space < 0 ? form : `${form}${verb.slice(space)}`
}

const isPastVerb = (word: string): word is PastVerb => Object.hasOwn(VERB_FORMS, word)

export function waitingVerb(verb: string): string {
  return verbIn(verb, "waiting")
}

export function failedVerb(verb: string): string {
  const waiting = verbIn(verb, "waiting")
  if (waiting === verb && !isPastVerb(verb.split(" ", 1)[0] ?? "")) return verb
  return `Failed to ${waiting.charAt(0).toLowerCase()}${waiting.slice(1)}`
}

export function runningVerb(verb: string): string {
  return verbIn(verb, "running")
}
