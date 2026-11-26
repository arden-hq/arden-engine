import { CONTAINED, INERT, OUTWARD, type CallImpact } from "../execution/impact.js"
import { NATIVE_ACTION, type NativeAction } from "../computer/contract.js"
import { BROWSER_ACT_ACTION } from "../browser/service.js"
import { keyChord } from "../computer/step.js"
import type { ActParametersSchema } from "./browser-parameters.js"

export const actImpact = (input: typeof ActParametersSchema.Type): CallImpact => {
  if (input.secret !== undefined) return { kind: "locked", category: "passwords" }
  switch (input.action) {
    case BROWSER_ACT_ACTION.scroll:
    case BROWSER_ACT_ACTION.hover:
    case BROWSER_ACT_ACTION.focus:
      return INERT
    case BROWSER_ACT_ACTION.fill:
    case BROWSER_ACT_ACTION.check:
    case BROWSER_ACT_ACTION.uncheck:
      return CONTAINED
    case BROWSER_ACT_ACTION.type:
      return typedImpact(input.value ?? "")
    case BROWSER_ACT_ACTION.press:
      return keyImpact(input.value ?? "")
    case BROWSER_ACT_ACTION.click:
    case BROWSER_ACT_ACTION.dblclick:
    case BROWSER_ACT_ACTION.select:
      return OUTWARD
  }
}

export const nativeActImpact = (input: NativeAction): CallImpact => {
  switch (input.action) {
    case NATIVE_ACTION.scroll:
      return INERT
    case NATIVE_ACTION.activate:
    case NATIVE_ACTION.set_value:
      return CONTAINED
    case NATIVE_ACTION.type:
      return typedImpact(input.text)
    case NATIVE_ACTION.key:
      return keyImpact(keyChord(input))
    case NATIVE_ACTION.click:
    case NATIVE_ACTION.pixel_click:
    case NATIVE_ACTION.menu:
    case NATIVE_ACTION.drag:
      return OUTWARD
  }
}

const typedImpact = (text: string): CallImpact => (/[\r\n]/u.test(text) ? OUTWARD : CONTAINED)

const SCROLL_KEYS = new Set(["pageup", "pagedown", "home", "end", "control+home", "control+end"])

const IN_PAGE_KEYS = new Set([
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "tab",
  "shift+tab",
  "escape",
  "control+a",
  "meta+a"
])

const KEY_NAMES: Readonly<Record<string, string>> = {
  cmd: "meta",
  command: "meta",
  controlormeta: "meta",
  ctrl: "control",
  option: "alt",
  esc: "escape",
  return: "enter",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright"
}

const MODIFIER_ORDER = ["alt", "control", "meta", "shift"]

const canonicalChord = (chord: string): string => {
  const parts = chord
    .trim()
    .toLowerCase()
    .split("+")
    .map((part) => KEY_NAMES[part] ?? part)
  const key = parts.at(-1) ?? ""
  const modifiers = parts
    .slice(0, -1)
    .toSorted((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
  return [...modifiers, key].join("+")
}

const keyImpact = (chord: string): CallImpact => {
  const canonical = canonicalChord(chord)
  if (SCROLL_KEYS.has(canonical)) return INERT
  return IN_PAGE_KEYS.has(canonical) ? CONTAINED : OUTWARD
}
