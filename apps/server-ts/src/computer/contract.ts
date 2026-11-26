import type { NativeVisual } from "./feedback.js"
import { Schema } from "effect"

export const NATIVE_BUTTON = { left: "left", right: "right", middle: "middle" } as const

const Id = Schema.Int.check(Schema.isGreaterThan(0))
const Token = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
export const NativeTargetSchema = Schema.Struct({ pid: Id, window_id: Id })
export type NativeTarget = typeof NativeTargetSchema.Type
const ActionFields = {
  target: NativeTargetSchema.annotate({
    description:
      "Exact pid and window_id of the window to act on. It must match the observation's window."
  }),
  observation: Token.annotate({
    description:
      "Observation ref from the latest computer_read state of this window. This call consumes it, even if the call fails."
  }),
  delivery: Schema.Literals(["background", "foreground"]).annotate({
    description:
      "background leaves the user's mouse and keyboard free. foreground visibly takes control and needs the user's grant for this chat unless foreground_allowed is true. activate, menu and drag take foreground only; set_value takes background only. A left pixel_click always runs as foreground."
  })
}
const Modifiers = Schema.Array(Schema.Literals(["cmd", "shift", "alt", "ctrl"])).check(
  Schema.isMaxLength(4)
)
const PointerFields = {
  button: Schema.optionalKey(
    Schema.Literals(Object.values(NATIVE_BUTTON)).annotate({
      description: "Mouse button for click, pixel_click and drag. Defaults to left."
    })
  ),
  modifiers: Schema.optionalKey(
    Modifiers.annotate({
      description:
        "Modifier keys held during click, pixel_click or drag (up to 4). A modified click needs foreground delivery."
    })
  )
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

export type NativeAxAction = (typeof NativeAxActions)[keyof typeof NativeAxActions]

export const NATIVE_ACTION = {
  set_value: "set_value",
  activate: "activate",
  click: "click",
  menu: "menu",
  type: "type",
  key: "key",
  scroll: "scroll",
  pixel_click: "pixel_click",
  drag: "drag"
} as const

export const NativeActionSchema = Schema.Union([
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal(NATIVE_ACTION.set_value),
    delivery: Schema.Literal("background"),
    element: Token.annotate({
      description: "element_token from the observation's elements."
    }),
    value: Schema.String.check(Schema.isMaxLength(10_000)).annotate({
      description:
        "Complete new value for the element; it replaces the current content (up to 10,000 characters). Used by set_value."
    })
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal(NATIVE_ACTION.activate),
    delivery: Schema.Literal("foreground")
  }),
  Schema.Struct({
    ...ActionFields,
    ...PointerFields,
    action: Schema.Literal(NATIVE_ACTION.click),
    element: Token.annotate({
      description: "element_token from the observation's elements."
    }),
    ax_action: Schema.optionalKey(
      Schema.Literals(Object.values(NativeAxActions)).annotate({
        description:
          "Accessibility action to invoke on the element, one listed in that element's actions. Used by click. The driver's default applies when omitted."
      })
    )
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal(NATIVE_ACTION.menu),
    delivery: Schema.Literal("foreground"),
    path: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)))
      .check(Schema.isMinLength(1), Schema.isMaxLength(16))
      .annotate({
        description:
          'Menu titles from the menu bar down to the item to invoke, such as ["File", "Save"] (1-16 titles of 1-200 characters). Used by menu.'
      })
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal(NATIVE_ACTION.type),
    element: Schema.optionalKey(
      Token.annotate({
        description:
          "element_token to type into, from the observation's elements. Defaults to the window's current focus."
      })
    ),
    text: Schema.String.check(Schema.isMaxLength(10_000)).annotate({
      description: "Text to type as keystrokes (up to 10,000 characters). Used by type."
    })
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal(NATIVE_ACTION.key),
    element: Schema.optionalKey(
      Token.annotate({
        description:
          "element_token to send the key to, from the observation's elements. Defaults to the window's current focus."
      })
    ),
    key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)).annotate({
      description:
        "Key to press, such as RETURN, TAB, DOWN or HOME (1-100 characters). Used by key."
    }),
    modifiers: Schema.optionalKey(
      Modifiers.annotate({
        description: "Modifier keys held while the key is pressed (up to 4). Defaults to none."
      })
    )
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal(NATIVE_ACTION.scroll),
    element: Token.annotate({
      description: "element_token of the element to scroll, from the observation's elements."
    }),
    direction: Schema.Literals(["up", "down", "left", "right"]).annotate({
      description: "Scroll direction. Used by scroll."
    }),
    amount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
      description: "How far to scroll, in the unit set by by (1-20). Used by scroll."
    }),
    by: Schema.Literals(["line", "page"]).annotate({
      description: "Unit of amount. Used by scroll."
    })
  }),
  Schema.Struct({
    ...ActionFields,
    ...PointerFields,
    action: Schema.Literal(NATIVE_ACTION.pixel_click),
    capture: Token.annotate({
      description:
        "capture_id from the same observation. Read it with screenshot=true so you see the image the coordinates refer to. Used by pixel_click and drag."
    }),
    x: Coordinate.annotate({
      description:
        "Click x in screenshot pixels from the left edge, never desktop frame coordinates. Used by pixel_click."
    }),
    y: Coordinate.annotate({
      description:
        "Click y in screenshot pixels from the top edge, never desktop frame coordinates. Used by pixel_click."
    }),
    count: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })).annotate({
        description:
          "Number of clicks (1-3). Used by pixel_click. The driver's default applies when omitted."
      })
    )
  }),
  Schema.Struct({
    ...ActionFields,
    ...PointerFields,
    action: Schema.Literal(NATIVE_ACTION.drag),
    delivery: Schema.Literal("foreground"),
    capture: Token.annotate({
      description:
        "capture_id from the same observation. Read it with screenshot=true so you see the image the coordinates refer to. Used by pixel_click and drag."
    }),
    from_x: Coordinate.annotate({
      description: "Drag start x in screenshot pixels from the left edge. Used by drag."
    }),
    from_y: Coordinate.annotate({
      description: "Drag start y in screenshot pixels from the top edge. Used by drag."
    }),
    to_x: Coordinate.annotate({
      description: "Drag end x in screenshot pixels from the left edge. Used by drag."
    }),
    to_y: Coordinate.annotate({
      description: "Drag end y in screenshot pixels from the top edge. Used by drag."
    }),
    duration_ms: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })).annotate({
        description:
          "Drag duration in milliseconds (0-10,000). Used by drag. The driver's default applies when omitted."
      })
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

export function nativeDelivery(action: NativeAction): "background" | "foreground" {
  if (action.action === "pixel_click" && (action.button ?? "left") === "left") return "foreground"
  return action.delivery
}
