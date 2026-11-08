import { Option, Schema } from "effect"
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

export interface RuntimeContext {
  readonly sections: ReadonlyArray<RuntimeSection>
  readonly endNote: string | undefined
}

const RuntimeStateSchema = Schema.Struct({
  sections: Schema.Record(Schema.String, Schema.String),
  turn: Schema.Record(Schema.String, Schema.String),
  space: Schema.optionalKey(Schema.Struct({ key: Schema.String, facts: SpaceFactsSchema }))
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

const sectionChanges = (
  presented: RuntimeState,
  current: RuntimeContext
): ReadonlyArray<string> => {
  const present = new Set(current.sections.map((section) => section.key))
  const changed = current.sections.flatMap((section) => {
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
  return {
    sections: Object.fromEntries(
      context.sections.flatMap((section) =>
        section.kind === "text" && section.lifetime === "state"
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
    ...(space === undefined ? {} : { space: { key: space.key, facts: spaceFacts(space.space) } })
  }
}

const joinParts = (parts: ReadonlyArray<string | undefined>): string =>
  parts
    .flatMap((part) => (part === undefined || part.trim() === "" ? [] : [part.trim()]))
    .join("\n\n")
