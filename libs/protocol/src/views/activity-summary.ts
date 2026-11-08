import { nounFor } from "@arden-hq/std/count"
import {
  isAskCall,
  namedTool,
  toolKindLabel,
  toolMeta,
  waitingVerb,
  type StepIconKey
} from "./tool-words.js"

/**
 * One call as the summary reads it. The desktop builds these from its loaded
 * rows (whose arguments and titles it knows); the server and a restored turn
 * build them from per-tool counts alone (`turnCallsSummaryText`).
 */
export interface SummaryCall {
  readonly id: string
  /** The tool's name as the server sends it; "" when unknown. */
  readonly name: string
  /** A spawned agent: counted per call, under "Started agents". */
  readonly agent: boolean
  /** The user turned the call down on its card: it never ran. */
  readonly rejected: boolean
  /** The tool's stable per-kind verb ("Read", "Searched email"). */
  readonly verb: string
  readonly iconKey: StepIconKey
  readonly noun: string | null
  /** What the call acted on (a path, query, command), which dedupes units. */
  readonly detail: string | null
  /** The tool's name in words, for a tool the registry does not know. */
  readonly displayName: string
}

const CLASS_ORDER = [
  "agents",
  "changes",
  "reads",
  "pages",
  "commands",
  "web",
  "mail",
  "slack",
  "calendar",
  "memory",
  "chats",
  "other"
] as const

type ActivityClass = (typeof CLASS_ORDER)[number]

interface ActivitySummaryPart {
  readonly kind: ActivityClass
  readonly count: number
  readonly label?: { readonly one: string; readonly many: string }
  readonly icon?: StepIconKey
}

const CLASS_TEXT: Record<ActivityClass, { one: string; many: string }> = {
  agents: { one: "Started an agent", many: "Started agents" },
  changes: { one: "Edited a file", many: "Edited files" },
  reads: { one: "Read a file", many: "Read files" },
  pages: { one: "Read a page", many: "Read pages" },
  commands: { one: "Ran a command", many: "Ran commands" },
  web: { one: "Searched the web", many: "Searched the web" },
  mail: { one: "Checked email", many: "Checked email" },
  slack: { one: "Checked Slack", many: "Checked Slack" },
  calendar: { one: "Checked the calendar", many: "Checked the calendar" },
  memory: { one: "Read memory", many: "Read memory" },
  chats: { one: "Read a Chat", many: "Read chats" },
  other: { one: "Used a tool", many: "Used tools" }
}

const CLASS_ICON: Record<ActivityClass, StepIconKey> = {
  agents: "dot",
  changes: "edit",
  reads: "file",
  pages: "globe",
  commands: "terminal",
  web: "globe",
  mail: "mail",
  slack: "slack",
  calendar: "calendar",
  memory: "book",
  chats: "history",
  other: "wrench"
}

const SUMMARY_PART_LIMIT = 3

const LIST_FORMAT = new Intl.ListFormat("en", { style: "long", type: "unit" })

function classFor(call: SummaryCall): ActivityClass {
  if (call.agent) return "agents"
  switch (call.iconKey) {
    case "edit":
    case "file-plus":
      return "changes"
    case "file":
    case "folder":
    case "table":
      return "reads"
    case "search":
      return call.name.startsWith("file_") ? "reads" : "other"
    case "mail":
      return "mail"
    case "slack":
      return "slack"
    case "calendar":
      return "calendar"
    case "book":
      return "memory"
    case "history":
      return "chats"
    case "globe":
      return call.noun === "page" ? "pages" : "web"
    case "terminal":
      return "commands"
    case "image":
    case "list":
    case "brain":
    case "clock":
    case "bell":
    case "wrench":
    case "app":
    case "browser":
    case "dot":
      return "other"
  }
}

function tailLabel(call: SummaryCall): { one: string; many: string; icon: StepIconKey } {
  if (call.rejected) {
    const asked = waitingVerb(call.verb)
    const one = `Asked to ${asked.charAt(0).toLowerCase()}${asked.slice(1)}`
    return { one, many: one, icon: call.iconKey }
  }
  const own = toolMeta(call.name)?.many
  const many =
    own ?? (call.noun ? `${call.verb.split(" ")[0]} ${nounFor(2, call.noun)}` : call.verb)
  return { one: call.verb, many, icon: call.iconKey }
}

function summaryParts(calls: readonly SummaryCall[]): ActivitySummaryPart[] {
  const units = new Map<ActivityClass, Set<string>>()
  const kinds = new Map<ActivityClass, Set<string>>()
  const tail = new Map<
    string,
    { label: { one: string; many: string }; icon: StepIconKey; count: number }
  >()
  for (const call of calls) {
    if (isAskCall(call.name)) continue
    const kind = classFor(call)
    if (kind === "other" || call.rejected) {
      const { one, many, icon } =
        kind === "other" && toolMeta(call.name) === undefined
          ? {
              one: `Used ${call.displayName}`,
              many: `Used ${call.displayName}`,
              icon: "wrench" as const
            }
          : tailLabel(call)
      const entry = tail.get(one) ?? { label: { one, many }, icon, count: 0 }
      entry.count += 1
      tail.set(one, entry)
      continue
    }
    const seen = units.get(kind) ?? new Set<string>()
    seen.add(kind === "agents" ? call.id : (call.detail ?? call.id))
    units.set(kind, seen)
    const tools = kinds.get(kind) ?? new Set<string>()
    const name = call.name.toLowerCase()
    tools.add(call.noun === (toolMeta(name)?.noun ?? null) ? name : `${name}:${call.noun}`)
    kinds.set(kind, tools)
  }
  return CLASS_ORDER.flatMap((kind): ActivitySummaryPart[] => {
    if (kind === "other") {
      return [...tail.values()].map(({ label, icon, count }) => ({ kind, count, label, icon }))
    }
    const seen = units.get(kind)
    if (!seen) return []
    const label = ownVerb(kinds.get(kind), seen.size)
    return [label ? { kind, count: seen.size, label } : { kind, count: seen.size }]
  })
}

function ownVerb(
  tools: ReadonlySet<string> | undefined,
  count: number
): { readonly one: string; readonly many: string } | undefined {
  if (tools?.size !== 1) return undefined
  const meta = toolMeta([...tools][0])
  if (!meta || meta.noun !== undefined || !meta.verb.includes(" ")) return undefined
  if (count > 1 && /\b(a|an)\b/.test(meta.verb)) return undefined
  return { one: meta.verb, many: meta.verb }
}

/** The glyph for a group of calls: its leading part's icon. */
export function callsSummaryIcon(calls: readonly SummaryCall[]): StepIconKey {
  const first = summaryParts(calls)[0]
  return first ? (first.icon ?? CLASS_ICON[first.kind]) : "dot"
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

/** One line for a finished trail — "Edited files, read files, ran commands".
 *  `position` picks the casing: `leading` opens a sentence, `following` sits
 *  after other words. Nothing to say reads "Done". */
export function callsSummaryText(
  calls: readonly SummaryCall[],
  position: "leading" | "following" = "leading"
): string {
  const parts = summaryParts(calls).slice(0, SUMMARY_PART_LIMIT)
  if (parts.length === 0) return position === "leading" ? "Done" : "done"
  return LIST_FORMAT.format(
    parts.map((part, index) => {
      const text = (part.label ?? CLASS_TEXT[part.kind])[part.count === 1 ? "one" : "many"]
      return index === 0 && position === "leading" ? text : lowerFirst(text)
    })
  )
}

interface TurnCallCount {
  readonly name: string
  readonly display_name: string | null
  readonly count: number
  readonly rejected?: number | undefined
}

/** What a turn did, from the turn record's per-tool counts, when its rows
 *  are not loaded (a restored turn, the phone). The counts stand in for the
 *  calls, so the words are the ones the rows would give once they arrive — a
 *  call the user turned down on its card included: it says what was asked,
 *  never that it was done. */
export function turnCallsSummaryText(calls: readonly TurnCallCount[]): string | undefined {
  const summary = calls
    .filter((call) => !isAskCall(call.name))
    .flatMap((call) => {
      const rejected = Math.min(call.rejected ?? 0, call.count)
      const tool = { name: call.name, displayName: call.display_name ?? undefined }
      const kind = toolKindLabel(tool)
      const displayName = namedTool(tool)
      return Array.from({ length: call.count }, (_, index): SummaryCall => ({
        id: `${call.name}:${index}`,
        name: call.name,
        agent: false,
        rejected: index >= call.count - rejected,
        verb: kind.verb,
        iconKey: kind.iconKey,
        noun: kind.noun,
        detail: null,
        displayName
      }))
    })
  return summary.length > 0 ? callsSummaryText(summary) : undefined
}
