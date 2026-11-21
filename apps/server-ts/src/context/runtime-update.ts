import type { ChatMessage } from "@arden-hq/loop"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Option, Schema } from "effect"
import {
  TaskDirectionReceiptSchema,
  type TaskDirectionReceipt
} from "../persistence/work/task-direction.js"
import {
  SpaceFactsSchema,
  spaceFacts,
  digest,
  renderSpaceChanges,
  type SpaceView
} from "./space-render.js"

export type RuntimeSection =
  | {
      readonly kind: "text"
      readonly key: string
      readonly text: string
      readonly lifetime: "state" | "turn"
    }
  | {
      readonly kind: "space"
      readonly key: string
      readonly text: string
      readonly space: SpaceView
    }
  | {
      readonly kind: "direction"
      readonly key: string
      readonly text: string
      readonly receipt: TaskDirectionReceipt
    }

/**
 * A text section, or none when `value` is blank. A value that opens with its own `## `
 * heading is keyed by that heading, else by `name`.
 */
export const textSection = (
  name: string,
  value: string | undefined,
  lifetime: "state" | "turn" = "state"
): ReadonlyArray<RuntimeSection> => {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === "") return []
  const heading = /^## (.+)/.exec(trimmed)?.[1]?.trim()
  return [{ kind: "text", key: heading ?? name, text: trimmed, lifetime }]
}

export interface RuntimeContext {
  readonly sections: ReadonlyArray<RuntimeSection>
  readonly endNote: string | undefined
}

const RuntimeStateSchema = Schema.Struct({
  sections: Schema.Record(Schema.String, Schema.String),
  turn: Schema.Record(Schema.String, Schema.String),
  space: Schema.optionalKey(Schema.Struct({ key: Schema.String, facts: SpaceFactsSchema })),
  direction: Schema.optionalKey(TaskDirectionReceiptSchema)
})
export type RuntimeState = typeof RuntimeStateSchema.Type

export interface RuntimeUpdate {
  readonly kind: "full" | "delta"
  readonly text: string
  readonly state: RuntimeState
}

const FULL_HEADER =
  "Current Arden runtime context. It replaces any earlier Arden runtime context; later updates name only what changed."
const DELTA_HEADER =
  "Arden runtime context update: only what changed since the last one. A section here replaces the earlier section of the same name; everything else stands."

export const runtimeUpdate = ({
  presented,
  current,
  endNoteDue
}: {
  readonly presented: RuntimeState | undefined
  readonly current: RuntimeContext
  readonly endNoteDue: boolean
}): RuntimeUpdate | undefined => {
  const state = runtimeState(current)
  if (presented === undefined) {
    if (current.sections.length === 0 && current.endNote === undefined) return undefined
    return {
      kind: "full",
      text: joinParts([
        FULL_HEADER,
        ...current.sections.map((section) => section.text),
        current.endNote
      ]),
      state
    }
  }
  const changes = sectionChanges(presented, current)
  if (changes.length === 0 && !(endNoteDue && current.endNote !== undefined)) return undefined
  return {
    kind: "delta",
    text: joinParts([
      ...(changes.length === 0 ? [] : [DELTA_HEADER, ...changes]),
      endNoteDue ? current.endNote : undefined
    ]),
    state
  }
}

export const presentedRuntimeState = (
  records: ReadonlyArray<{ readonly update: unknown; readonly state: unknown }>
): RuntimeState | undefined => {
  const latest = records.at(-1)
  if (latest === undefined || !records.some((record) => record.update === "full")) return undefined
  return Option.getOrUndefined(decodeState(latest.state))
}

const decodeState = Schema.decodeUnknownOption(RuntimeStateSchema)

export const producingTaskDirection = (
  messages: ReadonlyArray<ChatMessage>,
  toolCallId: string
): TaskDirectionReceipt | undefined => {
  const asked = messages.findIndex(
    (message) =>
      message.role === ROLE.assistant &&
      (message.tool_calls ?? []).some((call) => call.id === toolCallId)
  )
  const record = messages
    .slice(0, Math.max(asked, 0))
    .findLast(
      (message) => message.role === ROLE.developer && message.arden_context_source === "runtime"
    )
  if (asked < 0 || record === undefined || record.role !== ROLE.developer) return undefined
  return Option.getOrUndefined(decodeState(record.arden_context_state))?.direction
}

const sectionChanges = (
  presented: RuntimeState,
  current: RuntimeContext
): ReadonlyArray<string> => {
  const present = new Set(current.sections.map((section) => section.key))
  const changed = current.sections.flatMap((section) => {
    if (section.kind === "direction")
      return presented.sections[section.key] === digest(section.text) ? [] : [section.text]
    if (section.kind === "space") {
      if (presented.space === undefined || presented.space.key !== section.key)
        return [section.text]
      return [renderSpaceChanges(presented.space.facts, section.space)].filter(
        (text) => text !== undefined
      )
    }
    const before =
      section.lifetime === "state" ? presented.sections[section.key] : presented.turn[section.key]
    return before === digest(section.text) ? [] : [section.text]
  })
  const removed = [
    ...Object.keys(presented.sections),
    ...(presented.space === undefined ? [] : [presented.space.key])
  ]
    .filter((key) => !present.has(key))
    .map((key) => `## ${key}\n\nNo longer applies.`)
  return [...changed, ...removed]
}

const runtimeState = (context: RuntimeContext): RuntimeState => {
  const space = context.sections.find((section) => section.kind === "space")
  const direction = context.sections.find((section) => section.kind === "direction")
  return {
    sections: Object.fromEntries(
      context.sections.flatMap((section) =>
        (section.kind === "text" && section.lifetime === "state") || section.kind === "direction"
          ? [[section.key, digest(section.text)]]
          : []
      )
    ),
    turn: Object.fromEntries(
      context.sections.flatMap((section) =>
        section.kind === "text" && section.lifetime === "turn"
          ? [[section.key, digest(section.text)]]
          : []
      )
    ),
    ...(space === undefined ? {} : { space: { key: space.key, facts: spaceFacts(space.space) } }),
    ...(direction === undefined ? {} : { direction: direction.receipt })
  }
}

const joinParts = (parts: ReadonlyArray<string | undefined>): string =>
  parts
    .flatMap((part) => (part === undefined || part.trim() === "" ? [] : [part.trim()]))
    .join("\n\n")
