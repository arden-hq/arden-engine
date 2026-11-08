import type { ComputerFrame, ComputerStep } from "@arden-hq/protocol/computer"
import type { NativeAction } from "./contract.js"

type App = ComputerStep["app"]

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
    case "activate":
      return `Brought ${app} forward`
    case "menu":
      return `Chose ${action.path.join(" → ")} in ${app}`
    case "click":
    case "pixel_click":
      return action.button === "right" ? `Right-clicked in ${app}` : `Clicked in ${app}`
    case "type":
      return `Typed in ${app}`
    case "set_value":
      return `Replaced text in ${app}`
    case "key":
      return `Pressed ${pressedKeys(action)} in ${app}`
    case "scroll":
      return `Scrolled in ${app}`
    case "drag":
      return `Dragged in ${app}`
  }
}

export function actionQuestion(action: NativeAction, app: string): string {
  switch (action.action) {
    case "activate":
      return `Bring ${app} forward?`
    case "menu":
      return `Choose ${action.path.join(" → ")} in ${app}?`
    case "click":
    case "pixel_click":
      return action.button === "right" ? `Right-click in ${app}?` : `Click in ${app}?`
    case "type":
      return `Type in ${app}?`
    case "set_value":
      return `Replace the text in ${app}?`
    case "key":
      return `Press ${keyChord(action)} in ${app}?`
    case "scroll":
      return `Scroll in ${app}?`
    case "drag":
      return `Drag in ${app}?`
  }
}

export function actionWords(action: NativeAction): string {
  switch (action.action) {
    case "activate":
      return "Bring the window forward"
    case "menu":
      return "Choose a menu item"
    case "click":
      return action.button === "right" ? "Right-click" : "Click"
    case "pixel_click":
      return action.button === "right" ? "Right-click a point" : "Click a point"
    case "type":
      return "Type text"
    case "set_value":
      return "Replace all text"
    case "key":
      return "Press keys"
    case "scroll":
      return `Scroll ${action.direction}`
    case "drag":
      return "Drag"
  }
}

export const findStep = (app: NonNullable<App>): ComputerStep => ({
  kind: "look",
  title: `Found ${app.name}`,
  app,
  window: null,
  frames: []
})

export const lookStep = (
  app: App,
  name: string,
  window: string | undefined,
  frame: Omit<ComputerFrame, "caption"> | undefined
): ComputerStep => {
  const title = `Looked at ${name}`
  return {
    kind: "look",
    title,
    app,
    window: window ?? null,
    frames: frame === undefined ? [] : [{ ...frame, caption: title }]
  }
}

export const actStep = (
  action: NativeAction,
  app: App,
  name: string,
  window: string | undefined
): ComputerStep => ({
  kind: "act",
  title: pastTitle(action, name),
  app,
  window: window ?? null,
  frames: []
})

export function scriptStep(steps: readonly ComputerStep[]): ComputerStep | undefined {
  const acts = steps.filter((step) => step.kind === "act")
  const [act] = acts
  const frames = replayFrames(steps)
  if (act !== undefined && acts.length === 1) return { ...act, frames }
  const last = (acts.length > 0 ? acts : steps).at(-1)
  if (last === undefined) return undefined
  if (acts.length === 0) return { ...last, frames }
  return { ...last, title: `Used ${last.app?.name ?? "an app"}`, frames }
}

function replayFrames(steps: readonly ComputerStep[]): ComputerFrame[] {
  const frames: ComputerFrame[] = []
  let change: string | undefined
  for (const step of steps) {
    if (step.kind === "act") change = step.title
    for (const frame of step.frames) {
      frames.push(change === undefined ? frame : { ...frame, caption: change })
      change = undefined
    }
  }
  return frames
}
