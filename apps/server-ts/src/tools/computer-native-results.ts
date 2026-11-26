import { nativeObservation } from "../computer/observation.js"
import { createHash } from "node:crypto"
import {
  CONTENT_BLOCK_TYPE,
  ToolExecutionError,
  type ToolResultOutput,
  type ModelContentBlock
} from "@arden-hq/loop"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Schema } from "effect"
import type { JsonObject } from "../persistence/json.js"
import { pointTarget, resolveRef, uiTargetData } from "./ui-target.js"
import {
  NATIVE_ACTION,
  NATIVE_BUTTON,
  type NativeAction,
  type NativeObservation
} from "../computer/contract.js"
import type { ComputerStep } from "@arden-hq/protocol/computer"
import { elementWords, keyChord } from "../computer/step.js"
import { StateSchema } from "./computer-native-schemas.js"

export const isState = Schema.is(StateSchema)
const isElementList = Schema.is(
  Schema.Struct({
    elements: Schema.Array(
      Schema.Struct({
        element_token: Schema.String,
        role: Schema.optionalKey(Schema.String),
        label: Schema.optionalKey(Schema.String)
      })
    )
  })
)

export function elementNames(state: unknown): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  if (!isElementList(state)) return names
  for (const element of state.elements) {
    const words = elementWords(element)
    if (words !== undefined) names.set(element.element_token, words)
  }
  return names
}
export const isConfirmed = Schema.is(Schema.Struct({ effect: Schema.Literal("confirmed") }))
const isJson = Schema.is(Schema.Json)

export type FrameChange = (key: string, data: string) => boolean

export const changedFrames = (): FrameChange => {
  const last = new Map<string, string>()
  return (key: string, data: string): boolean => {
    const digest = createHash("sha1").update(data).digest("base64")
    if (last.get(key) === digest) return false
    if (last.size >= 256) last.clear()
    last.set(key, digest)
    return true
  }
}

export const actTarget = (
  input: NativeAction,
  seen: NativeObservation | undefined
): { readonly ui_target?: JsonObject } => {
  if (input.action === NATIVE_ACTION.pixel_click)
    return uiTargetData(
      pointTarget(`A click on capture ${input.capture} at (${input.x}, ${input.y})`)
    )
  if (input.action === NATIVE_ACTION.drag)
    return uiTargetData(
      pointTarget(
        `A drag on capture ${input.capture} from (${input.from_x}, ${input.from_y}) to (${input.to_x}, ${input.to_y})`
      )
    )
  if (!("element" in input) || input.element === undefined) return {}
  return uiTargetData(
    resolveRef({
      ref: input.element,
      label: seen?.elements.get(input.element),
      near: undefined,
      why: "it is not named in this run's latest observation of the window"
    })
  )
}

export interface ForegroundCardFields {
  readonly preview: string
  readonly presentation: {
    readonly title: string
    readonly note: string
    readonly approve_label: string
    readonly reject_label: string
  }
  readonly data: { readonly reviewer: string; readonly grant: string }
}

export const foregroundCard = <P extends { presentation: object; data: object }>(
  prompt: P
): P & ForegroundCardFields => ({
  ...prompt,
  preview: "Arden asks to use your mouse and keyboard",
  presentation: {
    ...prompt.presentation,
    title: "Let Arden use your mouse and keyboard?",
    note: "Arden brings the app forward and clicks or types in it. This holds for this chat until you take control.",
    approve_label: "Allow for this chat",
    reject_label: "Not now"
  },
  data: { ...prompt.data, reviewer: "user", grant: "foreground" }
})

export const output = (
  result: CallToolResult,
  observation?: string,
  screenshot = false,
  step?: ComputerStep
): ToolResultOutput => {
  const text = result.content
    .flatMap((block) => (block.type === CONTENT_BLOCK_TYPE.text ? [block.text] : []))
    .join("\n")
    .slice(0, 24_000)
  if (result.isError)
    throw new ToolExecutionError(text || "Native driver refused the operation", {
      preview: "Computer action failed; inspect state",
      retryable: false
    })
  const images: ModelContentBlock[] = result.content
    .flatMap((block): ModelContentBlock[] =>
      block.type === CONTENT_BLOCK_TYPE.image && block.data.length <= 8_000_000
        ? [{ type: "image", media_type: block.mimeType, data: block.data }]
        : []
    )
    .slice(0, 1)
  const structured = isJson(result.structuredContent) ? result.structuredContent : null
  const visibleState = nativeObservation(structured, screenshot)
  const visible =
    structured === null
      ? `${observation === undefined ? "" : `Observation: ${observation}\n`}${text}`
      : JSON.stringify({ observation: observation ?? null, state: visibleState })
  return {
    result: visible,
    preview: observation === undefined ? "Native computer result" : "Observed native window",
    data: {
      observation: observation ?? null,
      state: visibleState,
      ...(step === undefined ? {} : { computer: step })
    },
    ...(images.length === 0 ? {} : { model_content: [{ type: "text", text: visible }, ...images] })
  }
}

export const actionLabel = (action: NativeAction): string => {
  switch (action.action) {
    case NATIVE_ACTION.activate:
      return "Bringing window forward"
    case NATIVE_ACTION.menu:
      return action.path.join(" → ")
    case NATIVE_ACTION.click:
      return action.button === NATIVE_BUTTON.right ? "Right-clicking control" : "Clicking control"
    case NATIVE_ACTION.pixel_click:
      return "Clicking in window"
    case NATIVE_ACTION.type:
      return "Typing text"
    case NATIVE_ACTION.set_value:
      return "Updating field"
    case NATIVE_ACTION.key:
      return `Pressing ${keyChord(action)}`
    case NATIVE_ACTION.scroll:
      return `Scrolling ${action.direction}`
    case NATIVE_ACTION.drag:
      return "Dragging in window"
  }
}
