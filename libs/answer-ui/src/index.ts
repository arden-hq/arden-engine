import { createStore, evaluateElementProps } from "@openuidev/lang-core"
import { library } from "./library.js"
import { COMPONENT_NAMES } from "./parts.js"
import { readAnswerBlock } from "./read.js"
import { blockText } from "./text.js"

export {
  ANSWER_PARTS,
  BAR_CHART_HIGHLIGHT,
  COMPONENT_NAME,
  COMPONENT_NAMES,
  type BarChartHighlight,
  type ComponentName,
  type IconName,
  type PartProps
} from "./parts.js"
export { FORMAT, formatAxis, formatFigure, type Format } from "./format.js"
export { FORMULA_VALUE_KIND, type FormulaValue } from "./formula.js"
export { formulaValue, PLOT_DATA_KIND, plotData, PlotSpec, type PlotData } from "./plot.js"
export { CHART_KIND, ChartSpec, DiagramSpec, type ChartKind } from "./specs.js"
export { ANSWER_UI_ROOT } from "./library.js"
export {
  BLOCK_GUARD_KIND,
  completeStatements,
  guardBlock,
  readAnswerBlock,
  type BlockGuard
} from "./read.js"

export function catalogSignatures(): string {
  const { components } = library.toSpec()
  return COMPONENT_NAMES.flatMap((name) => {
    const spec = components[name]
    return spec === undefined ? [] : [`${spec.signature} — ${spec.description}`]
  }).join("\n")
}

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
