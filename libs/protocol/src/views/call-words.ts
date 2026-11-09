import { clipLine } from "@arden-hq/std/text"
import { toolKindLabel, type StepIconKey } from "./tool-words.js"
import { isRecord } from "@arden-hq/std/json"

/**
 * One call's own words: its verb and the thing it acted on, from its name and
 * arguments. The desktop's trail row and the phone's tool rail both name a
 * call here, so one call never reads two ways.
 */

/** One call as its row reads it. `args` is the parsed argument object, or
 *  null while it is not (yet) one. */
export interface CallWordsInput {
  readonly name: string | undefined
  readonly displayName: string | undefined
  readonly args: Readonly<Record<string, unknown>> | null
  /** The server's rendering hints, preferred over the registry's. */
  readonly icon?: string | null | undefined
  readonly noun?: string | null | undefined
}

/** A call's arguments as an object, or null while they are partial JSON or
 *  not an object at all. */
export function parseCallArgs(args: string | undefined): Record<string, unknown> | null {
  if (!args) return null
  try {
    const parsed: unknown = JSON.parse(args)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Stable per-KIND words — no per-call title, no argument detail — so a run
 *  of differently-titled calls still groups under one label. */
export function callKindWords(call: CallWordsInput): {
  verb: string
  iconKey: StepIconKey
  noun: string | null
} {
  const page = webPageAction(call)
  if (page !== undefined) return { verb: page, iconKey: "globe", noun: "page" }
  if (readsSavedOutput(call)) return { verb: "Read the full output", iconKey: "file", noun: null }
  const base = toolKindLabel({ name: call.name, displayName: call.displayName })
  return {
    verb: base.verb,
    iconKey: asIconKey(call.icon) ?? base.iconKey,
    noun: call.noun ?? base.noun
  }
}

/** What kind of thing a call's object is, so a row can draw it as that thing:
 *  a path, a command (code), an address, or plain words. */
export type CallSubjectKind = "path" | "code" | "url" | "text"

export interface CallSubject {
  readonly kind: CallSubjectKind
  readonly value: string
}

/** What one call acted on — a path, query, command — clipped to `max`, with
 *  the kind of thing it is; null when its arguments name nothing a reader can
 *  use. A code run names what its script called, which only its result knows,
 *  so it has none here. */
export function callSubject(call: CallWordsInput, max: number): CallSubject | null {
  const name = call.name?.toLowerCase() ?? ""
  if (SCRIPT_TOOLS.has(name) || TOOL_ID_ARGS.has(name)) return null
  if (readsSavedOutput(call)) {
    const grep = call.args?.grep
    if (typeof grep === "string" && grep.trim()) return { kind: "text", value: clipLine(grep, max) }
    const offset = call.args?.offset
    if (typeof offset === "number" && Number.isInteger(offset) && offset >= 1) {
      return { kind: "text", value: clipLine(`From line ${offset}`, max) }
    }
    return null
  }
  if (name === "artifact_save") {
    const saved = savedArtifactDetail(call.args, max)
    return saved === null ? null : { kind: "text", value: saved }
  }
  return subjectFromArgs(call.args, max)
}

/** The row kind the desktop gives one `phase()` of a Code Mode script; no
 *  tool has this name. */
export const CODE_MODE_PHASE_KIND = "code_mode_phase"

const SCRIPT_TOOLS: ReadonlySet<string> = new Set(["code_mode", CODE_MODE_PHASE_KIND])

const TOOL_ID_ARGS: ReadonlySet<string> = new Set(["tool_search", "load_tools"])

const DETAIL_KEYS = [
  "path",
  "file_path",
  "filename",
  "file",
  "query",
  "q",
  "command",
  "cmd",
  "url",
  "pattern",
  "name",
  "tools",
  "prompt",
  "task",
  "channel",
  "id"
] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isInternalValue(value: string): boolean {
  const text = value.trim()
  return UUID.test(text) || text.startsWith("arden:") || /(^|\/)\.arden(\/|$)/.test(text)
}

const SUBJECT_KIND: Readonly<Record<string, CallSubjectKind>> = {
  path: "path",
  file_path: "path",
  filename: "path",
  file: "path",
  command: "code",
  cmd: "code",
  url: "url"
}

function clipSubject(kind: CallSubjectKind, text: string, max: number): string {
  if (kind !== "path") return clipLine(text, max)
  return text.trim().replace(/\s+/g, " ")
}

function subjectFromArgs(args: CallWordsInput["args"], max: number): CallSubject | null {
  if (!args) return null
  for (const key of DETAIL_KEYS) {
    const kind = SUBJECT_KIND[key] ?? "text"
    const value = args[key]
    if (typeof value === "string" && value.trim()) {
      if (isInternalValue(value)) continue
      return { kind, value: clipSubject(kind, value, max) }
    }
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === "string")
    ) {
      const shown = value.filter((item) => !isInternalValue(item))
      if (shown.length > 0) return { kind, value: clipSubject(kind, shown.join(", "), max) }
    }
  }
  return null
}

const ICON_KEYS: ReadonlySet<string> = new Set<StepIconKey>([
  "search",
  "globe",
  "file",
  "edit",
  "file-plus",
  "folder",
  "terminal",
  "brain",
  "book",
  "list",
  "mail",
  "slack",
  "calendar",
  "clock",
  "bell",
  "image",
  "wrench",
  "history",
  "table",
  "app",
  "browser",
  "dot"
])

const isIconKey = (value: string): value is StepIconKey => ICON_KEYS.has(value)

function asIconKey(value: string | null | undefined): StepIconKey | null {
  return value && isIconKey(value) ? value : null
}

const SAVED_OUTPUT_PREFIX = "arden:managed-output/"

function readsSavedOutput(call: CallWordsInput): boolean {
  if (call.name !== "file_read") return false
  const path = call.args?.path
  return typeof path === "string" && path.trim().startsWith(SAVED_OUTPUT_PREFIX)
}

function webPageAction(call: CallWordsInput): string | undefined {
  if (call.name?.toLowerCase() !== "web_search") return undefined
  const type = call.args?.type
  if (type === "open_page") return "Read a page"
  if (type === "find_in_page") return "Searched a page"
  return undefined
}

/** A run of web_search calls read pages only if every call opened or searched
 *  one; any query makes the run a web search. */
export function readsPagesOnly(calls: readonly CallWordsInput[]): boolean {
  return calls.every((call) => webPageAction(call) !== undefined)
}

function savedArtifactDetail(args: CallWordsInput["args"], max: number): string | null {
  for (const value of [args?.title, args?.filename]) {
    if (typeof value === "string" && value.trim() !== "") return clipLine(value, max)
  }
  const path = args?.path
  if (typeof path !== "string" || path.trim() === "") return null
  const text = path.trim()
  return clipLine(text.slice(text.lastIndexOf("/") + 1) || text, max)
}
