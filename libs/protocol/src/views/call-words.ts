import { parseJsonTextOrUndefined } from "../common/json-text.js"
import { clipLine } from "@arden-hq/std/text"
import { STEP_ICON, toolKindLabel, type StepIconKey, type ToolNaming } from "./tool-words.js"
import { TOOL_NOUN, VIEWED_TOOL, type ViewedTool } from "./tool-registry.js"
import { isRecord } from "@arden-hq/std/json"

export interface CallWordsInput extends ToolNaming {
  readonly args: Readonly<Record<string, unknown>> | null
  readonly icon: string | null
  readonly noun: string | null
}

export function parseCallArgs(args: string | undefined): Record<string, unknown> | null {
  if (!args) return null
  const parsed = parseJsonTextOrUndefined(args)
  return isRecord(parsed) ? parsed : null
}

export function callKindWords(call: CallWordsInput): {
  verb: string
  iconKey: StepIconKey
  noun: string | null
} {
  const page = webPageAction(call)
  if (page !== undefined) return { verb: page, iconKey: STEP_ICON.globe, noun: TOOL_NOUN.page }
  if (readsSavedOutput(call)) return { verb: "Read the full output", iconKey: "file", noun: null }
  const base = toolKindLabel(call)
  return {
    verb: base.verb,
    iconKey: asIconKey(call.icon) ?? base.iconKey,
    noun: call.noun ?? base.noun
  }
}

export const CALL_SUBJECT = { path: "path", code: "code", url: "url", text: "text" } as const
export type CallSubjectKind = (typeof CALL_SUBJECT)[keyof typeof CALL_SUBJECT]

export interface CallSubject {
  readonly kind: CallSubjectKind
  readonly value: string
}

export function callSubject(call: CallWordsInput, max: number): CallSubject | null {
  const name = call.name.toLowerCase()
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
  if (name === VIEWED_TOOL.artifact_save) {
    const saved = savedArtifactDetail(call.args, max)
    return saved === null ? null : { kind: "text", value: saved }
  }
  return subjectFromArgs(call.args, max)
}

export const CODE_MODE_PHASE_KIND = VIEWED_TOOL.code_mode_phase

const SCRIPT_TOOLS: ReadonlySet<string> = new Set<ViewedTool>([
  VIEWED_TOOL.code_mode,
  VIEWED_TOOL.code_mode_phase
])

const TOOL_ID_ARGS: ReadonlySet<string> = new Set<ViewedTool>([
  VIEWED_TOOL.tool_search,
  VIEWED_TOOL.load_tools
])

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
  if (kind !== CALL_SUBJECT.path) return clipLine(text, max)
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

const ICON_KEYS: ReadonlySet<string> = new Set<StepIconKey>(Object.values(STEP_ICON))

const isIconKey = (value: string): value is StepIconKey => ICON_KEYS.has(value)

function asIconKey(value: string | null): StepIconKey | null {
  return value && isIconKey(value) ? value : null
}

const SAVED_OUTPUT_PREFIX = "arden:managed-output/"

function readsSavedOutput(call: CallWordsInput): boolean {
  if (call.name !== VIEWED_TOOL.file_read) return false
  const path = call.args?.path
  return typeof path === "string" && path.trim().startsWith(SAVED_OUTPUT_PREFIX)
}

const WEB_PAGE_ACTION = { open_page: "open_page", find_in_page: "find_in_page" } as const
type WebPageAction = (typeof WEB_PAGE_ACTION)[keyof typeof WEB_PAGE_ACTION]

const WEB_PAGE_ACTIONS: ReadonlySet<string> = new Set<WebPageAction>(Object.values(WEB_PAGE_ACTION))

const isWebPageAction = (value: string): value is WebPageAction => WEB_PAGE_ACTIONS.has(value)

const WEB_PAGE_ACTION_WORDS: Record<WebPageAction, string> = {
  open_page: "Read a page",
  find_in_page: "Searched a page"
}

function webPageAction(call: CallWordsInput): string | undefined {
  if (call.name.toLowerCase() !== VIEWED_TOOL.web_search) return undefined
  const type = call.args?.type
  return typeof type === "string" && isWebPageAction(type) ? WEB_PAGE_ACTION_WORDS[type] : undefined
}

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
