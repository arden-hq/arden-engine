import { nounFor } from "@arden-hq/std/count"
import {
  isAskCall,
  namedTool,
  toolKindLabel,
  toolManyWords,
  toolMeta,
  toolNoun,
  waitingVerb,
  STEP_ICON,
  type StepIconKey
} from "./tool-words.js"
import { TOOL_NOUN } from "./tool-registry.js"

export interface SummaryCall {
  readonly id: string
  readonly name: string
  readonly agent: boolean
  readonly rejected: boolean
  readonly verb: string
  readonly iconKey: StepIconKey
  readonly noun: string | null
  readonly detail: string | null
  readonly displayName: string
}

const ACTIVITY_CLASS = {
  agents: "agents",
  changes: "changes",
  reads: "reads",
  pages: "pages",
  commands: "commands",
  web: "web",
  mail: "mail",
  slack: "slack",
  calendar: "calendar",
  memory: "memory",
  chats: "chats",
  other: "other"
} as const

type ActivityClass = (typeof ACTIVITY_CLASS)[keyof typeof ACTIVITY_CLASS]

const CLASS_ORDER = Object.values(ACTIVITY_CLASS)

export const SUMMARY_POSITION = { leading: "leading", following: "following" } as const
export type SummaryPosition = (typeof SUMMARY_POSITION)[keyof typeof SUMMARY_POSITION]

interface ActivitySummaryPart {
  readonly kind: ActivityClass
  readonly count: number
  readonly label: { readonly one: string; readonly many: string }
  readonly icon: StepIconKey
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
  if (call.agent) return ACTIVITY_CLASS.agents
  switch (call.iconKey) {
    case STEP_ICON.edit:
    case STEP_ICON.filePlus:
      return ACTIVITY_CLASS.changes
    case STEP_ICON.file:
    case STEP_ICON.folder:
    case STEP_ICON.table:
      return ACTIVITY_CLASS.reads
    case STEP_ICON.search:
      return call.name.startsWith("file_") ? ACTIVITY_CLASS.reads : ACTIVITY_CLASS.other
    case STEP_ICON.mail:
      return ACTIVITY_CLASS.mail
    case STEP_ICON.slack:
      return ACTIVITY_CLASS.slack
    case STEP_ICON.calendar:
      return ACTIVITY_CLASS.calendar
    case STEP_ICON.book:
      return ACTIVITY_CLASS.memory
    case STEP_ICON.history:
      return ACTIVITY_CLASS.chats
    case STEP_ICON.globe:
      return call.noun === TOOL_NOUN.page ? ACTIVITY_CLASS.pages : ACTIVITY_CLASS.web
    case STEP_ICON.terminal:
      return ACTIVITY_CLASS.commands
    case STEP_ICON.image:
    case STEP_ICON.list:
    case STEP_ICON.brain:
    case STEP_ICON.clock:
    case STEP_ICON.bell:
    case STEP_ICON.wrench:
    case STEP_ICON.app:
    case STEP_ICON.browser:
    case STEP_ICON.dot:
      return ACTIVITY_CLASS.other
  }
}

function tailLabel(call: SummaryCall): { one: string; many: string; icon: StepIconKey } {
  if (call.rejected) {
    const asked = waitingVerb(call.verb)
    const one = `Asked to ${asked.charAt(0).toLowerCase()}${asked.slice(1)}`
    return { one, many: one, icon: call.iconKey }
  }
  const own = toolManyWords(call.name)
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
    if (kind === ACTIVITY_CLASS.other || call.rejected) {
      const { one, many, icon } =
        kind === ACTIVITY_CLASS.other && toolMeta(call.name) === undefined
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
    seen.add(kind === ACTIVITY_CLASS.agents ? call.id : (call.detail ?? call.id))
    units.set(kind, seen)
    const tools = kinds.get(kind) ?? new Set<string>()
    const name = call.name.toLowerCase()
    tools.add(call.noun === toolNoun(name) ? name : `${name}:${call.noun}`)
    kinds.set(kind, tools)
  }
  return CLASS_ORDER.flatMap((kind): ActivitySummaryPart[] => {
    if (kind === ACTIVITY_CLASS.other) {
      return [...tail.values()].map(({ label, icon, count }) => ({ kind, count, label, icon }))
    }
    const seen = units.get(kind)
    if (!seen) return []
    const label = ownVerb(kinds.get(kind), seen.size) ?? CLASS_TEXT[kind]
    return [{ kind, count: seen.size, label, icon: CLASS_ICON[kind] }]
  })
}

function ownVerb(
  tools: ReadonlySet<string> | undefined,
  count: number
): { readonly one: string; readonly many: string } | undefined {
  if (tools?.size !== 1) return undefined
  const [name] = tools
  const meta = toolMeta(name)
  if (name === undefined || !meta || toolNoun(name) !== null || !meta.verb.includes(" ")) {
    return undefined
  }
  if (count > 1 && /\b(a|an)\b/.test(meta.verb)) return undefined
  return { one: meta.verb, many: meta.verb }
}

export function callsSummaryIcon(calls: readonly SummaryCall[]): StepIconKey {
  const first = summaryParts(calls)[0]
  return first ? first.icon : "dot"
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

export function callsSummaryText(
  calls: readonly SummaryCall[],
  position: SummaryPosition = SUMMARY_POSITION.leading
): string {
  const parts = summaryParts(calls).slice(0, SUMMARY_PART_LIMIT)
  if (parts.length === 0) return position === SUMMARY_POSITION.leading ? "Done" : "done"
  return LIST_FORMAT.format(
    parts.map((part, index) => {
      const text = part.label[part.count === 1 ? "one" : "many"]
      return index === 0 && position === SUMMARY_POSITION.leading ? text : lowerFirst(text)
    })
  )
}

interface TurnCallCount {
  readonly name: string
  readonly display_name: string | null
  readonly count: number
  readonly rejected: number
}

export function turnCallsSummaryText(calls: readonly TurnCallCount[]): string | undefined {
  const summary = calls
    .filter((call) => !isAskCall(call.name))
    .flatMap((call) => {
      const rejected = Math.min(call.rejected, call.count)
      const tool = { name: call.name, displayName: call.display_name }
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
