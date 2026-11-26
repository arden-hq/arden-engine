import {
  INTERNAL_TOOLS,
  TOOL_GROUP,
  TOOL_GROUP_WORDS,
  TOOL_META,
  type ToolMeta
} from "./tool-registry.js"

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

/** The vocabulary entry a send the user kept with Save as draft on its card
 *  reads with: it says a draft was saved, not that mail was sent. */
export const SAVED_DRAFT_WORDS = "email_draft"

/** `ask_user` and `permission_offer`: the question card is the call's visible
 *  result, drawn by the transcript on its own, so the trail neither draws nor
 *  counts the call. */
const ASK_CALLS: ReadonlySet<string> = new Set(["ask_user", "permission_offer"])

export function isAskCall(kind: string | undefined): boolean {
  return kind !== undefined && ASK_CALLS.has(kind.toLowerCase())
}

export function isPublicActivityTool(
  name: string,
  presentation: "work" | "conversation" | "status" | undefined
): boolean {
  return presentation !== "status" && !INTERNAL_TOOLS.has(name.toLowerCase())
}

/** The registry entry for a tool name, if the tool is one the app knows. The
 *  trail summary uses this to decide whether a group can speak in the tool's
 *  own words or falls back to "Called tools". */
export function toolMeta(kind: string | undefined): ToolMeta | undefined {
  return kind ? TOOL_META[kind.toLowerCase()] : undefined
}

export function toolNoun(kind: string): string | null {
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

/** What the reader calls a tool the app has no verb for: its own display
 *  name, or its name — never a bare "a tool". */
export function namedTool(tool: ToolNaming): string {
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

export type VerbPhrase = PastVerb | `${PastVerb} ${string}`

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
