import { createStore, evaluateElementProps } from "@openuidev/lang-core"
import { library } from "./library.js"
import { COMPONENT_NAMES } from "./parts.js"
import { readAnswerBlock } from "./read.js"
import { blockText } from "./text.js"

export {
  ANSWER_PARTS,
  COMPONENT_NAMES,
  type ComponentName,
  type IconName,
  type PartProps
} from "./parts.js"
export { formatAxis, formatFigure, type Format } from "./format.js"
export { formulaValue, plotData, PlotSpec, type PlotData } from "./plot.js"
export { ChartSpec, DiagramSpec } from "./specs.js"
export { ANSWER_UI_ROOT } from "./library.js"
export { completeStatements, guardBlock, readAnswerBlock } from "./read.js"

/** One line per part, "Name(arg, arg?…) — description", in the parts' order:
 *  the catalog the prompt shows the model. */
export function catalogSignatures(): string {
  const { components } = library.toSpec()
  return COMPONENT_NAMES.flatMap((name) => {
    const spec = components[name]
    return spec === undefined ? [] : [`${spec.signature} — ${spec.description}`]
  }).join("\n")
}

/** A block as compact plain Markdown: its title, figures, table, verdict, the
 *  value of each control and its buttons, computed for `state` over the
 *  block's declared defaults (keys are the `$variable` names; a value may come
 *  as the runtime's store holds it, `{ value, componentType }`). The text the
 *  block stands as wherever it cannot be drawn: older turns of the model's
 *  history, the clipboard. Empty when `readAnswerBlock` refuses the block or
 *  it has no root. */
export function answerBlockText(
  source: string,
  state: Readonly<Record<string, unknown>> = {}
): string {
  const parsed = readAnswerBlock(source)
  if (parsed === undefined || parsed.root === null) return ""
  const store = createStore()
  store.initialize(parsed.stateDeclarations, state)
  const read = (name: string) => unwrapFieldValue(store.get(name))
  const root = evaluateElementProps(parsed.root, {
    ctx: { getState: read, resolveRef: () => undefined },
    library,
    store,
    errors: []
  })
  return blockText(root, read)
}

function unwrapFieldValue(value: unknown): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "value" in value
    ? value.value
    : value
}
