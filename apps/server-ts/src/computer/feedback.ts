import { Schema } from "effect"
import type { ComputerFeedback } from "@arden-hq/protocol/computer"
import type { NativeAction } from "./contract.js"

const Rect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number
})
const Visual = Schema.Struct({
  screenshot_frame_valid: Schema.Literal(true),
  screenshot_width: Schema.Number.check(Schema.isGreaterThan(0)),
  screenshot_height: Schema.Number.check(Schema.isGreaterThan(0)),
  elements: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        element_token: Schema.String,
        screenshot_frame: Schema.optionalKey(Rect)
      })
    )
  )
})
const isVisual = Schema.is(Visual)
export type NativeVisual = Omit<typeof Visual.Type, "elements"> & {
  readonly elements: NonNullable<(typeof Visual.Type)["elements"]>
}

export function nativeVisual(state: unknown): NativeVisual | undefined {
  if (!isVisual(state)) return undefined
  return {
    screenshot_frame_valid: true,
    screenshot_width: state.screenshot_width,
    screenshot_height: state.screenshot_height,
    elements: (state.elements ?? []).map(({ element_token, screenshot_frame }) => ({
      element_token,
      ...(screenshot_frame === undefined ? {} : { screenshot_frame })
    }))
  }
}

export function nativeFeedback({
  action,
  visual
}: {
  action: NativeAction
  visual: NativeVisual | undefined
}): ComputerFeedback | null {
  if (visual === undefined) return null
  const frame = { width: visual.screenshot_width, height: visual.screenshot_height }
  const base = { id: action.observation, frame }
  if (action.action === "pixel_click") return { ...base, kind: "pointer", x: action.x, y: action.y }
  if (action.action === "drag") return { ...base, kind: "pointer", x: action.to_x, y: action.to_y }
  if (!("element" in action) || action.element === undefined) return null
  const rect = visual.elements.find(
    (element) => element.element_token === action.element
  )?.screenshot_frame
  if (rect === undefined || rect.w <= 0 || rect.h <= 0) return null
  const x = Math.max(0, rect.x)
  const y = Math.max(0, rect.y)
  const width = Math.min(frame.width, rect.x + rect.w) - x
  const height = Math.min(frame.height, rect.y + rect.h) - y
  if (width <= 0 || height <= 0) return null
  return { ...base, kind: "target", x, y, width, height }
}
