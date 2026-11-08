import type { ElementNode, ParseResult } from "@openuidev/lang-core"
import { unboundFieldName } from "./controls.js"
import { readAnswerBlock } from "./read.js"
import { ANSWER_PARTS, COMPONENT_NAMES, type ComponentName } from "./parts.js"

/** The most one block's saved values may take, in UTF-8 bytes of their JSON. */
export const ANSWER_BLOCK_STATE_MAX_BYTES = 8 * 1024

/** A block's saved values: each `$name` the block declares, and the
 *  `{ value }` of each control that binds no `$variable`, by its field name. */
export type AnswerBlockState = Readonly<Record<string, unknown>>

export type SavedBlockState =
  | { readonly kind: "saved"; readonly state: AnswerBlockState }
  /** The kept values are still over {@link ANSWER_BLOCK_STATE_MAX_BYTES}. */
  | { readonly kind: "too_large" }
  /** The block itself is refused by `readAnswerBlock`: it is shown as code,
   *  so it has no controls to save. */
  | { readonly kind: "unreadable" }

/**
 * The part of what a client sent for a block that may be saved. Only the
 * `$name`s the block declares are kept, each only when it has the declared
 * default's kind. A value a control binds must also pass that control's prop
 * schema: a number is clamped to the control's literal `min`/`max`, a choice
 * must be one of its options (a checklist keeps only its own items). Anything
 * else is dropped, so a stale key or a forged value never reaches the store or
 * the model; the block then shows that key's default.
 *
 * A control that binds no `$variable` keeps its choice too: the renderer files
 * it under the control's field name as `{ value }`, kept when the block has
 * such a control and the value passes the same checks.
 */
export function savedBlockState(source: string, sent: AnswerBlockState): SavedBlockState {
  const parsed = readAnswerBlock(source)
  if (parsed === undefined) return { kind: "unreadable" }
  const bindings = new Map<string, Array<Binding>>()
  if (parsed.root !== null) collectBindings(parsed.root, bindings)
  const state: Record<string, unknown> = {}
  for (const [key, initial] of Object.entries(parsed.stateDeclarations)) {
    if (!Object.hasOwn(sent, key)) continue
    const value = checkedValue(sent[key], initial, bindings.get(key) ?? [])
    if (value !== undefined) state[key] = value
  }
  const unbound = new Map<string, ElementNode>()
  if (parsed.root !== null) collectUnbound(parsed.root, unbound)
  for (const [field, part] of unbound) {
    const sentField = sent[field]
    if (!isFieldValue(sentField)) continue
    const value = checkedValue(sentField.value, null, [{ part, prop: "value" }])
    if (value !== undefined) state[field] = { value }
  }
  return utf8Bytes(JSON.stringify(state)) > ANSWER_BLOCK_STATE_MAX_BYTES
    ? { kind: "too_large" }
    : { kind: "saved", state }
}

interface Binding {
  readonly part: ElementNode
  readonly prop: string
}

function collectBindings(value: unknown, into: Map<string, Array<Binding>>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectBindings(item, into)
    return
  }
  if (!isElement(value)) return
  for (const [prop, propValue] of Object.entries(value.props)) {
    const target = stateRefName(propValue)
    if (target !== undefined) into.set(target, [...(into.get(target) ?? []), { part: value, prop }])
    else collectBindings(propValue, into)
  }
}

/** Whether a parsed block has anything the person can set: a declared
 *  `$variable`, or a control that binds none. */
export function blockHasControls(parsed: ParseResult): boolean {
  if (Object.keys(parsed.stateDeclarations).length > 0) return true
  const unbound = new Map<string, ElementNode>()
  if (parsed.root !== null) collectUnbound(parsed.root, unbound)
  return unbound.size > 0
}

const isStateRef = (value: unknown) => stateRefName(value) !== undefined

function collectUnbound(value: unknown, into: Map<string, ElementNode>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectUnbound(item, into)
    return
  }
  if (!isElement(value)) return
  const field = unboundFieldName(value, isStateRef)
  if (field !== undefined && !into.has(field)) into.set(field, value)
  for (const propValue of Object.values(value.props)) collectUnbound(propValue, into)
}

function isFieldValue(value: unknown): value is { readonly value: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "value" in value
}

function checkedValue(value: unknown, initial: unknown, bindings: ReadonlyArray<Binding>): unknown {
  if (initial !== null && kindOf(value) !== kindOf(initial)) return undefined
  if (typeof value === "number" && !Number.isFinite(value)) return undefined
  let checked = value
  for (const { part, prop } of bindings) {
    if (checked === undefined) return undefined
    if (propSchema(part.typeName, prop)?.safeParse(checked).success === false) return undefined
    if (prop === "value") checked = withinControl(checked, part)
  }
  return checked
}

function withinControl(value: unknown, part: ElementNode): unknown {
  const { min, max } = part.props
  if (typeof value === "number") {
    const low = typeof min === "number" ? Math.max(value, min) : value
    return typeof max === "number" ? Math.min(low, max) : low
  }
  const options = optionValues(part)
  if (options === undefined) return value
  if (typeof value === "string") return options.has(value) ? value : undefined
  if (Array.isArray(value)) return value.filter((item) => options.has(item))
  return value
}

function optionValues(part: ElementNode): ReadonlySet<unknown> | undefined {
  for (const propValue of Object.values(part.props)) {
    if (!Array.isArray(propValue)) continue
    const values = propValue.flatMap((item) =>
      isElement(item) && typeof item.props.value === "string" ? [item.props.value] : []
    )
    if (values.length > 0) return new Set(values)
  }
  return undefined
}

function propSchema(typeName: string, prop: string) {
  if (!isComponentName(typeName)) return undefined
  const shape: Readonly<Record<string, { safeParse: (v: unknown) => { success: boolean } }>> =
    ANSWER_PARTS[typeName].props.shape
  return shape[prop]
}

function kindOf(value: unknown): string {
  if (value === null) return "null"
  return Array.isArray(value) ? "array" : typeof value
}

function stateRefName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  if (!("k" in value) || value.k !== "StateRef" || !("n" in value)) return undefined
  return typeof value.n === "string" ? value.n : undefined
}

function isElement(value: unknown): value is ElementNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "element" &&
    "typeName" in value &&
    typeof value.typeName === "string" &&
    "props" in value &&
    typeof value.props === "object" &&
    value.props !== null
  )
}

function utf8Bytes(text: string): number {
  let bytes = 0
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0
    if (point < 0x80) bytes += 1
    else if (point < 0x800) bytes += 2
    else bytes += point < 0x10000 ? 3 : 4
  }
  return bytes
}

const isComponentName = (name: string): name is ComponentName =>
  (COMPONENT_NAMES as ReadonlyArray<string>).includes(name)
