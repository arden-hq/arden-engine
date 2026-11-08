import { clipLine } from "@arden-hq/std/text"
import { countOf } from "@arden-hq/std/count"
import { bounded, omittedLine, relevantFirst } from "../models/decisions/bounded-input.js"
import { FIELD_WEIGHT } from "../memory/lexical-score.js"
import type {
  SpaceReviewGateEvidence,
  SpaceReviewReads,
  GateTurn
} from "../persistence/automations/space-review.js"

const GATE_TASK_LINES = 12
const GATE_PROPOSAL_LINES = 5
const GATE_BUDGET = 4_000
const TURN_CHARS = 300

type Unit =
  | { readonly kind: "page"; readonly page: SpaceReviewReads["pages"][number] }
  | { readonly kind: "turn"; readonly turn: GateTurn; readonly anchor: boolean }
  | { readonly kind: "removed"; readonly path: string }
  | { readonly kind: "item"; readonly item: SpaceReviewReads["items"][number] }

export const spaceReviewGateText = (
  reads: SpaceReviewReads,
  evidence: SpaceReviewGateEvidence
): string => {
  const openTasks = bounded(reads.openTasks, GATE_TASK_LINES)
  const proposals = bounded(reads.proposals, GATE_PROPOSAL_LINES)
  const newest = new Map<string, GateTurn>()
  for (const turn of evidence.turns) {
    const known = newest.get(turn.sessionId)
    if (known === undefined || turn.startedAt > known.startedAt) newest.set(turn.sessionId, turn)
  }
  const units: ReadonlyArray<Unit> = [
    ...reads.pages.map((page) => ({ kind: "page" as const, page })),
    ...evidence.turns.map((turn) => ({
      kind: "turn" as const,
      turn,
      anchor: newest.get(turn.sessionId) === turn
    })),
    ...reads.removed.map((path) => ({ kind: "removed" as const, path })),
    ...reads.items.filter((item) => item.isNew).map((item) => ({ kind: "item" as const, item }))
  ]
  const selected = relevantFirst(units, {
    query: [...reads.openTasks.map((task) => task.text), ...reads.proposals].join("\n"),
    budget: GATE_BUDGET,
    candidate: (unit) => {
      const lines = unitLines(unit)
      return {
        fields: unitFields(unit),
        at: unitAt(unit),
        size: lines.reduce((sum, line) => sum + line.length + 1, 0),
        anchor: unit.kind === "turn" && unit.anchor
      }
    }
  })
  const shown = (kind: Unit["kind"]) => selected.shown.filter((unit) => unit.kind === kind)
  const left = (kind: Unit["kind"]) =>
    units.filter((unit) => unit.kind === kind).length - shown(kind).length
  const changed = [
    ...shown("page").flatMap(unitLines),
    ...omittedLine(left("page"), "Memory pages"),
    ...chatLines(shown("turn").flatMap((unit) => (unit.kind === "turn" ? [unit.turn] : []))),
    ...omittedLine(left("turn") + evidence.unread, "changed Chat turns"),
    ...shown("removed").flatMap(unitLines),
    ...omittedLine(left("removed"), "removed sources"),
    ...shown("item").flatMap(unitLines),
    ...omittedLine(left("item"), "new mail items"),
    ...seenLine(reads.items.filter((item) => !item.isNew).length)
  ]
  return [
    `Space: ${reads.space.name || "this Space"}`,
    `Instructions: ${clipLine(reads.space.instructions ?? "", 1300)}`,
    openTasks.shown.length === 0 ? "Open Tasks: none" : "Open Tasks:",
    ...openTasks.shown.map((task) => `- ${clipLine(task.text, 150)} (${task.status})`),
    ...omittedLine(openTasks.omitted, "open Tasks"),
    `Open Task proposals waiting on the person: ${reads.proposals.length}`,
    ...proposals.shown.map((text) => `- ${clipLine(text, 150)}`),
    ...omittedLine(proposals.omitted, "proposals"),
    `What woke this review: ${evidence.wokenBy.join(", ") || "unknown"}`,
    "Changed since the previous review:",
    ...(changed.length === 0 ? ["- (nothing listed)"] : changed)
  ].join("\n")
}

const seenLine = (seen: number): ReadonlyArray<string> =>
  seen === 0 ? [] : [`- (${countOf(seen, "earlier mail item")}, seen by the previous review)`]

const unitLines = (unit: Unit): ReadonlyArray<string> => {
  switch (unit.kind) {
    case "page":
      return [
        `- Memory page ${unit.page.path} (${unit.page.basis}, ${unit.page.previousVersion === null ? "new" : "revised"})`
      ]
    case "turn":
      return turnLines(unit.turn)
    case "removed":
      return [`- Source removed: ${unit.path}`]
    case "item":
      return [
        `- Mail "${clipLine(unit.item.title, 90)}" from ${clipLine(unit.item.sender || "?", 40)}: ${clipLine(unit.item.snippet, 160)}`
      ]
  }
}

const turnLines = (turn: GateTurn): ReadonlyArray<string> => [
  ...(turn.user === undefined ? [] : [`    user: ${clipLine(turn.user, TURN_CHARS)}`]),
  ...(turn.assistant === undefined
    ? []
    : [`    assistant: ${clipLine(turn.assistant, TURN_CHARS)}`])
]

const unitFields = (
  unit: Unit
): ReadonlyArray<{ readonly text: string; readonly weight: number }> => {
  switch (unit.kind) {
    case "page":
      return [{ text: unit.page.path, weight: FIELD_WEIGHT.path }]
    case "turn":
      return [
        { text: unit.turn.chatTitle ?? "", weight: FIELD_WEIGHT.title },
        { text: turnLines(unit.turn).join("\n"), weight: FIELD_WEIGHT.body }
      ]
    case "removed":
      return [{ text: unit.path, weight: FIELD_WEIGHT.path }]
    case "item":
      return [
        { text: unit.item.title, weight: FIELD_WEIGHT.title },
        { text: unit.item.sender ?? "", weight: FIELD_WEIGHT.path },
        { text: unit.item.snippet, weight: FIELD_WEIGHT.body }
      ]
  }
}

const unitAt = (unit: Unit): string => {
  switch (unit.kind) {
    case "turn":
      return unit.turn.startedAt
    case "item":
      return unit.item.receivedAt
    case "page":
    case "removed":
      return ""
  }
}

const chatLines = (turns: ReadonlyArray<GateTurn>): ReadonlyArray<string> =>
  [...Map.groupBy(turns, (turn) => turn.sessionId).values()].flatMap((chat) => [
    `- Chat "${clipLine(chat[0]?.chatTitle || "untitled", 80)}"`,
    ...chat.flatMap(turnLines)
  ])
