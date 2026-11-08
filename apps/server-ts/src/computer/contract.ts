import type { NativeVisual } from "./feedback.js"
import { Schema } from "effect"

const Id = Schema.Int.check(Schema.isGreaterThan(0))
const Token = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
export const NativeTargetSchema = Schema.Struct({ pid: Id, window_id: Id })
export type NativeTarget = typeof NativeTargetSchema.Type
const ActionFields = {
  target: NativeTargetSchema,
  observation: Token,
  delivery: Schema.Literals(["background", "foreground"])
}
const Modifiers = Schema.Array(Schema.Literals(["cmd", "shift", "alt", "ctrl"])).check(
  Schema.isMaxLength(4)
)
const PointerFields = {
  button: Schema.optionalKey(Schema.Literals(["left", "right", "middle"])),
  modifiers: Schema.optionalKey(Modifiers)
}
const Coordinate = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))

export const NativeAxActions = {
  AXPress: "press",
  AXShowMenu: "show_menu",
  AXPick: "pick",
  AXConfirm: "confirm",
  AXCancel: "cancel",
  AXOpen: "open"
} as const

export const NativeActionSchema = Schema.Union([
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal("set_value"),
    delivery: Schema.Literal("background"),
    element: Token,
    value: Schema.String.check(Schema.isMaxLength(10_000))
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal("activate"),
    delivery: Schema.Literal("foreground")
  }),
  Schema.Struct({
    ...ActionFields,
    ...PointerFields,
    action: Schema.Literal("click"),
    element: Token,
    ax_action: Schema.optionalKey(Schema.Literals(Object.values(NativeAxActions)))
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal("menu"),
    delivery: Schema.Literal("foreground"),
    path: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(16)
    )
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal("type"),
    element: Schema.optionalKey(Token),
    text: Schema.String.check(Schema.isMaxLength(10_000))
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal("key"),
    element: Schema.optionalKey(Token),
    key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    modifiers: Schema.optionalKey(Modifiers)
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal("scroll"),
    element: Token,
    direction: Schema.Literals(["up", "down", "left", "right"]),
    amount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
    by: Schema.Literals(["line", "page"])
  }),
  Schema.Struct({
    ...ActionFields,
    ...PointerFields,
    action: Schema.Literal("pixel_click"),
    capture: Token,
    x: Coordinate,
    y: Coordinate,
    count: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })))
  }),
  Schema.Struct({
    ...ActionFields,
    ...PointerFields,
    action: Schema.Literal("drag"),
    delivery: Schema.Literal("foreground"),
    capture: Token,
    from_x: Coordinate,
    from_y: Coordinate,
    to_x: Coordinate,
    to_y: Coordinate,
    duration_ms: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))
    )
  })
])
export type NativeAction = typeof NativeActionSchema.Type

export interface NativeObservation {
  readonly owner: string
  readonly label: string
  readonly app: string | undefined
  readonly window: string | undefined
  readonly elements: ReadonlyMap<string, string>
  readonly target: NativeTarget
  readonly snapshot: string | undefined
  readonly capture: string | undefined
  readonly visual: NativeVisual | undefined
}

export class NativeObservations {
  readonly #entries = new Map<string, NativeObservation>()

  remember(reference: string, observation: NativeObservation): void {
    this.forget(observation.target)
    if (this.#entries.size >= 64) this.#entries.clear()
    this.#entries.set(reference, observation)
  }

  forget(target: NativeTarget): void {
    for (const [reference, observation] of this.#entries) {
      if (
        observation.target.pid === target.pid &&
        observation.target.window_id === target.window_id
      ) {
        this.#entries.delete(reference)
      }
    }
  }

  clear(): void {
    this.#entries.clear()
  }

  peek(owner: string, reference: string): NativeObservation | undefined {
    const observation = this.#entries.get(reference)
    return observation?.owner === owner ? observation : undefined
  }

  consume(owner: string, action: NativeAction): NativeObservation {
    const observation = this.#entries.get(action.observation)
    if (
      observation === undefined ||
      observation.owner !== owner ||
      observation.target.pid !== action.target.pid ||
      observation.target.window_id !== action.target.window_id
    ) {
      throw new Error("Fresh observation of this exact window is required")
    }
    this.#entries.delete(action.observation)
    if (action.action === "activate" || action.action === "menu") return observation
    if (action.action === "pixel_click" || action.action === "drag") {
      if (observation.capture === undefined || observation.capture !== action.capture) {
        throw new Error("Pixel input requires the capture returned by this observation")
      }
    } else if (
      action.element !== undefined &&
      (observation.snapshot === undefined ||
        !action.element.startsWith(`${observation.snapshot}:`) ||
        !/^s[0-9a-f]+:[0-9]+$/u.test(action.element))
    ) {
      throw new Error("Element token does not belong to this observation")
    }
    return observation
  }
}

export const nativeDriverAction = (
  action: NativeAction
): {
  readonly name: string
  readonly args: Readonly<Record<string, Schema.Json>>
} => {
  const args = { ...action.target, delivery_mode: action.delivery }
  switch (action.action) {
    case "activate":
      return { name: "bring_to_front", args: { ...action.target } }
    case "set_value":
      return {
        name: "set_value",
        args: { ...action.target, element_token: action.element, value: action.value }
      }
    case "menu":
      return { name: "invoke_menu", args: { ...action.target, path: [...action.path] } }
    case "click":
      return {
        name: "click",
        args: {
          ...args,
          element_token: action.element,
          ...(action.ax_action === undefined ? {} : { action: action.ax_action }),
          ...(action.button === undefined ? {} : { button: action.button }),
          ...(action.modifiers === undefined ? {} : { modifier: [...action.modifiers] })
        }
      }
    case "type":
      return {
        name: "type_text",
        args: {
          ...args,
          ...(action.element === undefined ? {} : { element_token: action.element }),
          text: action.text
        }
      }
    case "key":
      return {
        name: "press_key",
        args: {
          ...args,
          ...(action.element === undefined ? {} : { element_token: action.element }),
          key: action.key,
          modifiers: action.modifiers ?? []
        }
      }
    case "scroll":
      return {
        name: "scroll",
        args: {
          ...args,
          element_token: action.element,
          direction: action.direction,
          amount: action.amount,
          by: action.by
        }
      }
    case "pixel_click":
      return {
        name: "click",
        args: {
          ...args,
          capture_id: action.capture,
          x: action.x,
          y: action.y,
          scope: "window",
          ...(action.button === undefined ? {} : { button: action.button }),
          ...(action.count === undefined ? {} : { count: action.count }),
          ...(action.modifiers === undefined ? {} : { modifier: [...action.modifiers] })
        }
      }
    case "drag":
      return {
        name: "drag",
        args: {
          ...args,
          scope: "window",
          from_x: action.from_x,
          from_y: action.from_y,
          to_x: action.to_x,
          to_y: action.to_y,
          ...(action.duration_ms === undefined ? {} : { duration_ms: action.duration_ms }),
          ...(action.button === undefined ? {} : { button: action.button }),
          ...(action.modifiers === undefined ? {} : { modifier: [...action.modifiers] })
        }
      }
  }
}

const isWindowList = Schema.is(
  Schema.Struct({
    windows: Schema.Array(
      Schema.Struct({
        pid: Id,
        window_id: Id,
        on_current_space: Schema.NullOr(Schema.Boolean),
        is_on_screen: Schema.Boolean
      })
    )
  })
)

/** Cua 0.34 can report exact focus while the window remains off-Space.
 * Check live visibility before every effective foreground input, including
 * background left-pixel clicks. Never infer visibility from activation success.
 * Attached-sheet input is also limited: https://github.com/trycua/cua/pull/4551
 * Revalidate both cases against a signed driver update before relaxing this guard. */
export const requireForegroundWindow = (target: NativeTarget, listing: unknown): void => {
  if (
    !isWindowList(listing) ||
    !listing.windows.some(
      (window) =>
        window.pid === target.pid &&
        window.window_id === target.window_id &&
        window.on_current_space &&
        window.is_on_screen
    )
  ) {
    throw new Error(
      "Foreground input requires this exact window to be visible on the current macOS Space. Use the authorized activate action, then observe again."
    )
  }
}

/** Cua 0.34's background left-pixel route activates AppKit without raising
 * the window. It still competes for user input, so requires foreground access. */
export function nativeDelivery(action: NativeAction): "background" | "foreground" {
  if (action.action === "pixel_click" && (action.button ?? "left") === "left") return "foreground"
  return action.delivery
}
