import type { ElementNode } from "@openuidev/lang-core"
import type { ComponentName } from "./parts.js"

const UNBOUND_FIELD = {
  Segmented: "name",
  Tabs: "name",
  OptionCards: "name",
  VisualCards: "name",
  Checklist: "name",
  Slider: "label",
  Switch: "label",
  Stepper: "label"
} as const satisfies Partial<Record<ComponentName, string>>

const isControl = (typeName: string): typeName is keyof typeof UNBOUND_FIELD =>
  Object.hasOwn(UNBOUND_FIELD, typeName)

export function unboundFieldName(
  part: ElementNode,
  bound: (value: unknown) => boolean
): string | undefined {
  if (!isControl(part.typeName) || bound(part.props.value)) return undefined
  const name = part.props[UNBOUND_FIELD[part.typeName]]
  return typeof name === "string" && !name.startsWith("$") ? name : undefined
}
