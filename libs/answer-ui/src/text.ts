import { cutText } from "@arden-hq/std/text"
import { isReactiveAssign, type ElementNode } from "@openuidev/lang-core"
import { isElement } from "./ast.js"
import { CONTROL_VALUE_PROP, unboundFieldName } from "./controls.js"
import { FORMAT, formatFigure, isFormat, type Format } from "./format.js"
import { FORMULA_VALUE_KIND } from "./formula.js"
import { COMPONENT_NAME, isComponentName } from "./parts.js"
import { formulaValue, PLOT_DATA_KIND, plotData, PlotSpec } from "./plot.js"
import { isRecord } from "@arden-hq/std/json"

const ANSWER_TEXT_MAX_CHARS = 4000
const TABLE_MAX_ROWS = 20
const LIST_MAX_ITEMS = 30

export function blockText(root: ElementNode, current: (name: string) => unknown): string {
  const text = partLines(withChoices(root, current), (value) =>
    isReactiveAssign(value) ? current(value.target) : value
  ).join("\n")
  return cutText(text, ANSWER_TEXT_MAX_CHARS)
}

function withChoices(node: ElementNode, current: (name: string) => unknown): ElementNode {
  const props = Object.fromEntries(
    Object.entries(node.props).map(([key, prop]) => [key, choicesIn(prop, current)])
  )
  const field = unboundFieldName(node, isReactiveAssign)
  const chosen = field === undefined ? undefined : current(field)
  return {
    ...node,
    props: chosen === undefined ? props : { ...props, [CONTROL_VALUE_PROP]: chosen }
  }
}

function choicesIn(value: unknown, current: (name: string) => unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => choicesIn(item, current))
  return isElement(value) ? withChoices(value, current) : value
}

type Read = (value: unknown) => unknown

function partLines(node: ElementNode, read: Read): string[] {
  const props = node.props
  const prop = (key: string) => read(props[key])
  const name = node.typeName
  if (!isComponentName(name)) return []
  switch (name) {
    case COMPONENT_NAME.Stack:
      return elements(props["children"]).flatMap((child) => partLines(child, read))
    case COMPONENT_NAME.Header:
      return [`## ${text(prop("title"))}`, ...optional(prop("subtitle"))]
    case COMPONENT_NAME.Summary:
      return elements(props["metrics"]).flatMap((metric) => partLines(metric, read))
    case COMPONENT_NAME.Metric: {
      const hint = text(prop("hint"))
      return [
        `${text(prop("label"))}: ${formatFigure(prop("value"), format(prop("format"), FORMAT.number))}${hint ? ` (${hint})` : ""}`
      ]
    }
    case COMPONENT_NAME.Formula: {
      const hint = text(prop("hint"))
      const fn = prop("fn")
      const vars = prop("vars")
      const value =
        typeof fn === "string" ? formulaValue(fn, isRecord(vars) ? vars : {}) : undefined
      return [
        `${text(prop("label"))}: ${value?.kind === FORMULA_VALUE_KIND.value ? formatFigure(value.value, format(prop("format"), FORMAT.number)) : "—"}${hint ? ` (${hint})` : ""}`
      ]
    }
    case COMPONENT_NAME.Plot: {
      const spec = PlotSpec.safeParse(prop("spec"))
      if (!spec.success) return []
      const data = plotData(spec.data)
      if (data.kind === PLOT_DATA_KIND.invalid) return []
      const shown = format(spec.data.format, FORMAT.number)
      const figure = (value: number | undefined) =>
        value === undefined ? "—" : formatFigure(value, shown)
      return data.series.map(
        (series) =>
          `${series.name}: ${figure(series.values[0])} → ${figure(series.values.at(-1))} (${series.values.length} points)`
      )
    }
    case COMPONENT_NAME.Tiles:
      return elements(props["tiles"]).flatMap((tile) => partLines(tile, read))
    case COMPONENT_NAME.Tile:
      return [`${text(prop("label"))}: ${formatFigure(prop("value"), FORMAT.text)}`]
    case COMPONENT_NAME.BarChart: {
      const values = array(prop("values"))
      const shown = format(prop("format"), FORMAT.number)
      return array(prop("labels"))
        .slice(0, LIST_MAX_ITEMS)
        .map((label, i) => `- ${text(label)}: ${formatFigure(values[i], shown)}`)
    }
    case COMPONENT_NAME.LineChart:
      return elements(props["series"]).map((series) => {
        const values = array(read(series.props["values"])).map(text)
        const name = text(read(series.props["name"]))
        return values.length === 0
          ? name
          : `${name}: ${values[0]} → ${values.at(-1)} (${values.length} points)`
      })
    case COMPONENT_NAME.Table:
      return tableLines(elements(props["columns"]), read)
    case COMPONENT_NAME.Callout: {
      const body = text(prop("text"))
      return [`**${text(prop("title"))}**${body ? ` ${body}` : ""}`]
    }
    case COMPONENT_NAME.Segmented: {
      const picked = prop("value")
      const option = elements(props["options"]).find((o) => read(o.props["value"]) === picked)
      const label = text(prop("label")) || text(prop("name"))
      return [`${label}: ${option ? text(read(option.props["label"])) : text(picked)}`]
    }
    case COMPONENT_NAME.OptionCards:
    case COMPONENT_NAME.VisualCards: {
      const picked = prop("value")
      const cards = elements(props[name === COMPONENT_NAME.OptionCards ? "options" : "cards"])
      return cards.slice(0, LIST_MAX_ITEMS).map((card) => {
        const value = read(card.props["value"])
        const mark = picked === undefined ? "-" : `- [${value === picked ? "x" : " "}]`
        const body = text(read(card.props["body"]))
        const tag = text(read(card.props["tag"]))
        return `${mark} ${text(read(card.props["title"]))}${body ? ` — ${body}` : ""}${tag ? ` (${tag})` : ""}`
      })
    }
    case COMPONENT_NAME.Slider: {
      const value = prop("value")
      const stops = array(prop("stops"))
      const at = typeof value === "number" ? stops[value] : undefined
      return [
        `${text(prop("label"))}: ${at === undefined ? withUnit(value, text(prop("unit"))) : text(at)}`
      ]
    }
    case COMPONENT_NAME.Stepper:
      return [`${text(prop("label"))}: ${text(prop("value"))}`]
    case COMPONENT_NAME.Switch:
      return [`${text(prop("label"))}: ${prop("value") === true ? "on" : "off"}`]
    case COMPONENT_NAME.List:
      return elements(props["rows"])
        .slice(0, LIST_MAX_ITEMS)
        .map((row) => {
          const on = read(row.props["value"])
          const mark = on === undefined ? "-" : `- [${on === true ? "x" : " "}]`
          const detail = text(read(row.props["detail"]))
          const amount = read(row.props["amount"])
          return `${mark} ${text(read(row.props["title"]))}${detail ? ` — ${detail}` : ""}${typeof amount === "number" ? ` (${amount})` : ""}`
        })
    case COMPONENT_NAME.Checklist: {
      const done = array(prop("value"))
      const title = text(prop("title"))
      const items = elements(props["items"]).slice(0, LIST_MAX_ITEMS)
      return [
        ...(title
          ? [
              `${title} (${items.filter((i) => done.includes(read(i.props["value"]))).length} of ${items.length} done)`
            ]
          : []),
        ...items.map((item) => {
          const time = text(read(item.props["time"]))
          const body = text(read(item.props["body"]))
          const mark = done.includes(read(item.props["value"])) ? "x" : " "
          return `- [${mark}] ${time ? `${time} ` : ""}${text(read(item.props["title"]))}${body ? ` — ${body}` : ""}`
        })
      ]
    }
    case COMPONENT_NAME.Tabs: {
      const picked = prop("value")
      const tabs = elements(props["items"])
      const tab = tabs.find((t) => read(t.props["value"]) === picked) ?? tabs[0]
      if (tab === undefined) return []
      return [
        `${text(read(tab.props["label"]))}:`,
        ...elements(tab.props["children"]).flatMap((child) => partLines(child, read))
      ]
    }
    case COMPONENT_NAME.Steps:
      return elements(props["items"])
        .slice(0, LIST_MAX_ITEMS)
        .map((step, i) => {
          const body = text(read(step.props["body"]))
          return `${i + 1}. ${text(read(step.props["title"]))}${body ? ` — ${body}` : ""}`
        })
    case COMPONENT_NAME.Gallery:
      return elements(props["photos"]).flatMap((photo) => partLines(photo, read))
    case COMPONENT_NAME.Photo:
      return optional(prop("caption"))
    case COMPONENT_NAME.Button:
      return [`[Button: ${text(prop("label"))}]`]
    case COMPONENT_NAME.Option:
    case COMPONENT_NAME.Col:
    case COMPONENT_NAME.Row:
    case COMPONENT_NAME.VisualCard:
    case COMPONENT_NAME.OptionCard:
    case COMPONENT_NAME.Step:
    case COMPONENT_NAME.TabItem:
    case COMPONENT_NAME.CheckItem:
    case COMPONENT_NAME.Series:
    case COMPONENT_NAME.Copy:
    case COMPONENT_NAME.Chart:
    case COMPONENT_NAME.Diagram:
    case COMPONENT_NAME.App:
    case COMPONENT_NAME.Rows:
    case COMPONENT_NAME.Image:
      return []
  }
}

function tableLines(columns: readonly ElementNode[], read: Read): string[] {
  if (columns.length === 0) return []
  const cells = columns.map((col) => {
    const shown = format(read(col.props["format"]), FORMAT.text)
    return array(read(col.props["cells"])).map((cell) => cellText(formatFigure(cell, shown)))
  })
  const rows = Math.min(Math.max(...cells.map((col) => col.length)), TABLE_MAX_ROWS)
  const row = (values: readonly string[]) => `| ${values.join(" | ")} |`
  return [
    row(columns.map((col) => cellText(text(read(col.props["label"]))))),
    row(columns.map(() => "---")),
    ...Array.from({ length: rows }, (_, r) => row(cells.map((col) => col[r] ?? "")))
  ]
}

const cellText = (value: string) => value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim()

const SLIDER_UNIT = { percent: "percent", count: "count" } as const
type SliderUnit = (typeof SLIDER_UNIT)[keyof typeof SLIDER_UNIT]
const SLIDER_UNITS: ReadonlySet<string> = new Set<SliderUnit>(Object.values(SLIDER_UNIT))
const isSliderUnit = (unit: string): unit is SliderUnit => SLIDER_UNITS.has(unit)

const SLIDER_UNIT_TEXT: Readonly<Record<SliderUnit, (shown: string) => string>> = {
  percent: (shown) => `${shown}%`,
  count: (shown) => shown
}

function withUnit(value: unknown, unit: string): string {
  const shown = text(value)
  if (isSliderUnit(unit)) return SLIDER_UNIT_TEXT[unit](shown)
  return unit ? `${shown} ${unit}` : shown
}

const elements = (value: unknown): ElementNode[] =>
  Array.isArray(value) ? value.filter(isElement) : []

const array = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])

function text(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

const optional = (value: unknown): string[] => {
  const line = text(value)
  return line ? [line] : []
}

const format = (value: unknown, fallback: Format): Format => (isFormat(value) ? value : fallback)
