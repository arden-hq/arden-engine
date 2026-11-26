import type {
  ComputerApp,
  ComputerFrame,
  ComputerStep,
  ComputerWindow
} from "@arden-hq/protocol/computer"
import { COMPUTER_APP, COMPUTER_STEP } from "@arden-hq/protocol/computer"
import { NATIVE_ACTION, NATIVE_BUTTON, type NativeAction } from "./contract.js"

export const appNameOf = (app: ComputerApp): string | undefined =>
  app.kind === COMPUTER_APP.identified ? app.name : undefined

const windowOf = (title: string | undefined): ComputerWindow =>
  title === undefined ? { kind: "untitled" } : { kind: "titled", title }

function roleWords(role: string): string {
  return role
    .replace(/^AX/u, "")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .toLowerCase()
}

export function elementWords(element: { role?: string; label?: string }): string | undefined {
  const label = element.label?.trim()
  const role = element.role === undefined ? undefined : roleWords(element.role)
  if (label) return role ? `${label} (${role})` : label
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : undefined
}

export const keyChord = (action: Extract<NativeAction, { action: "key" }>): string =>
  [...(action.modifiers ?? []), action.key].join("+")

const NAMED_KEYS = new Set([
  "return",
  "enter",
  "tab",
  "escape",
  "esc",
  "space",
  "delete",
  "forwarddelete",
  "backspace",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright"
])

const pressedKeys = (action: Extract<NativeAction, { action: "key" }>): string =>
  action.key.length === 1 ||
  /^f(?:[1-9]|1[0-9]|2[0-4])$/iu.test(action.key) ||
  NAMED_KEYS.has(action.key.toLowerCase())
    ? keyChord(action)
    : "a key"

export function pastTitle(action: NativeAction, app: string): string {
  switch (action.action) {
    case NATIVE_ACTION.activate:
      return `Brought ${app} forward`
    case NATIVE_ACTION.menu:
      return `Chose ${action.path.join(" → ")} in ${app}`
    case NATIVE_ACTION.click:
    case NATIVE_ACTION.pixel_click:
      return action.button === NATIVE_BUTTON.right ? `Right-clicked in ${app}` : `Clicked in ${app}`
    case NATIVE_ACTION.type:
      return `Typed in ${app}`
    case NATIVE_ACTION.set_value:
      return `Replaced text in ${app}`
    case NATIVE_ACTION.key:
      return `Pressed ${pressedKeys(action)} in ${app}`
    case NATIVE_ACTION.scroll:
      return `Scrolled in ${app}`
    case NATIVE_ACTION.drag:
      return `Dragged in ${app}`
  }
}

export function actionQuestion(action: NativeAction, app: string): string {
  switch (action.action) {
    case NATIVE_ACTION.activate:
      return `Bring ${app} forward?`
    case NATIVE_ACTION.menu:
      return `Choose ${action.path.join(" → ")} in ${app}?`
    case NATIVE_ACTION.click:
    case NATIVE_ACTION.pixel_click:
      return action.button === NATIVE_BUTTON.right ? `Right-click in ${app}?` : `Click in ${app}?`
    case NATIVE_ACTION.type:
      return `Type in ${app}?`
    case NATIVE_ACTION.set_value:
      return `Replace the text in ${app}?`
    case NATIVE_ACTION.key:
      return `Press ${keyChord(action)} in ${app}?`
    case NATIVE_ACTION.scroll:
      return `Scroll in ${app}?`
    case NATIVE_ACTION.drag:
      return `Drag in ${app}?`
  }
}

export function actionWords(action: NativeAction): string {
  switch (action.action) {
    case NATIVE_ACTION.activate:
      return "Bring the window forward"
    case NATIVE_ACTION.menu:
      return "Choose a menu item"
    case NATIVE_ACTION.click:
      return action.button === NATIVE_BUTTON.right ? "Right-click" : "Click"
    case NATIVE_ACTION.pixel_click:
      return action.button === NATIVE_BUTTON.right ? "Right-click a point" : "Click a point"
    case NATIVE_ACTION.type:
      return "Type text"
    case NATIVE_ACTION.set_value:
      return "Replace all text"
    case NATIVE_ACTION.key:
      return "Press keys"
    case NATIVE_ACTION.scroll:
      return `Scroll ${action.direction}`
    case NATIVE_ACTION.drag:
      return "Drag"
  }
}

export const findStep = (app: ComputerApp | undefined): ComputerStep | undefined =>
  app?.kind === COMPUTER_APP.identified
    ? { kind: "look", title: `Found ${app.name}`, app, window: { kind: "untitled" }, frames: [] }
    : undefined

export const lookStep = (
  app: ComputerApp,
  name: string,
  window: string | undefined,
  frame: Omit<ComputerFrame, "caption"> | undefined
): ComputerStep => {
  const title = `Looked at ${name}`
  return {
    kind: "look",
    title,
    app,
    window: windowOf(window),
    frames: frame === undefined ? [] : [{ ...frame, caption: title }]
  }
}

export const actStep = (
  action: NativeAction,
  app: ComputerApp,
  name: string,
  window: string | undefined
): ComputerStep => ({
  kind: "act",
  title: pastTitle(action, name),
  app,
  window: windowOf(window),
  frames: []
})

export function scriptStep(steps: readonly ComputerStep[]): ComputerStep | undefined {
  const acts = steps.filter((step) => step.kind === COMPUTER_STEP.act)
  const [act] = acts
  const frames = replayFrames(steps)
  if (act !== undefined && acts.length === 1) return { ...act, frames }
  const last = (acts.length > 0 ? acts : steps).at(-1)
  if (last === undefined) return undefined
  if (acts.length === 0) return { ...last, frames }
  return { ...last, title: `Used ${appNameOf(last.app) ?? "an app"}`, frames }
}

function replayFrames(steps: readonly ComputerStep[]): ComputerFrame[] {
  const frames: ComputerFrame[] = []
  let change: string | undefined
  for (const step of steps) {
    if (step.kind === COMPUTER_STEP.act) change = step.title
    for (const frame of step.frames) {
      frames.push(change === undefined ? frame : { ...frame, caption: change })
      change = undefined
    }
  }
  return frames
}
