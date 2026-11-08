import { cutText } from "@arden-hq/std/text"
import { isReactiveAssign, type ElementNode } from "@openuidev/lang-core"
import { unboundFieldName } from "./controls.js"
import { formatFigure, isFormat, type Format } from "./format.js"
import { formulaValue, plotData, PlotSpec } from "./plot.js"
import { isRecord } from "@arden-hq/std/json"

const ANSWER_TEXT_MAX_CHARS = 4000
const TABLE_MAX_ROWS = 20
const LIST_MAX_ITEMS = 30

/** An evaluated block as compact plain Markdown, one line per thing a reader
 *  takes in: the title, figures, a table, the verdict, the current value of
 *  each control, buttons by their label. A part it does not know is left out.
 *  `current` reads a store entry: a bound `$variable`'s value, or the choice a
 *  control that binds none keeps under its field name. */
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
  return { ...node, props: chosen === undefined ? props : { ...props, value: chosen } }
}

function choicesIn(value: unknown, current: (name: string) => unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => choicesIn(item, current))
  return isElement(value) ? withChoices(value, current) : value
}

type Read = (value: unknown) => unknown

function partLines(node: ElementNode, read: Read): string[] {
  const props = node.props
  const prop = (key: string) => read(props[key])
  switch (node.typeName) {
    case "Stack":
      return elements(props["children"]).flatMap((child) => partLines(child, read))
    case "Header":
      return [`## ${text(prop("title"))}`, ...optional(prop("subtitle"))]
    case "Summary":
      return elements(props["metrics"]).flatMap((metric) => partLines(metric, read))
    case "Metric": {
      const hint = text(prop("hint"))
      return [
        `${text(prop("label"))}: ${formatFigure(prop("value"), format(prop("format"), "number"))}${hint ? ` (${hint})` : ""}`
      ]
    }
    case "Formula": {
      const hint = text(prop("hint"))
      const fn = prop("fn")
      const vars = prop("vars")
      const value =
        typeof fn === "string" ? formulaValue(fn, isRecord(vars) ? vars : {}) : undefined
      return [
        `${text(prop("label"))}: ${value?.kind === "value" ? formatFigure(value.value, format(prop("format"), "number")) : "—"}${hint ? ` (${hint})` : ""}`
      ]
    }
    case "Plot": {
      const spec = PlotSpec.safeParse(prop("spec"))
      if (!spec.success) return []
      const data = plotData(spec.data)
      if (data.kind === "invalid") return []
      const shown = format(spec.data.format, "number")
      const figure = (value: number | undefined) =>
        value === undefined ? "—" : formatFigure(value, shown)
      return data.series.map(
        (series) =>
          `${series.name}: ${figure(series.values[0])} → ${figure(series.values.at(-1))} (${series.values.length} points)`
      )
    }
    case "Tiles":
      return elements(props["tiles"]).flatMap((tile) => partLines(tile, read))
    case "Tile":
      return [`${text(prop("label"))}: ${formatFigure(prop("value"), "text")}`]
    case "BarChart": {
      const values = array(prop("values"))
      const shown = format(prop("format"), "number")
      return array(prop("labels"))
        .slice(0, LIST_MAX_ITEMS)
        .map((label, i) => `- ${text(label)}: ${formatFigure(values[i], shown)}`)
    }
    case "LineChart":
      return elements(props["series"]).map((series) => {
        const values = array(read(series.props["values"])).map(text)
        const name = text(read(series.props["name"]))
        return values.length === 0
          ? name
          : `${name}: ${values[0]} → ${values.at(-1)} (${values.length} points)`
      })
    case "Table":
      return tableLines(elements(props["columns"]), read)
    case "Callout": {
      const body = text(prop("text"))
      return [`**${text(prop("title"))}**${body ? ` ${body}` : ""}`]
    }
    case "Segmented": {
      const picked = prop("value")
      const option = elements(props["options"]).find((o) => read(o.props["value"]) === picked)
      const label = text(prop("label")) || text(prop("name"))
      return [`${label}: ${option ? text(read(option.props["label"])) : text(picked)}`]
    }
    case "OptionCards":
    case "VisualCards": {
      const picked = prop("value")
      const cards = elements(props[node.typeName === "OptionCards" ? "options" : "cards"])
      return cards.slice(0, LIST_MAX_ITEMS).map((card) => {
        const value = read(card.props["value"])
        const mark = picked === undefined ? "-" : `- [${value === picked ? "x" : " "}]`
        const body = text(read(card.props["body"]))
        const tag = text(read(card.props["tag"]))
        return `${mark} ${text(read(card.props["title"]))}${body ? ` — ${body}` : ""}${tag ? ` (${tag})` : ""}`
      })
    }
    case "Slider": {
      const value = prop("value")
      const stops = array(prop("stops"))
      const at = typeof value === "number" ? stops[value] : undefined
      return [
        `${text(prop("label"))}: ${at === undefined ? withUnit(value, text(prop("unit"))) : text(at)}`
      ]
    }
    case "Stepper":
      return [`${text(prop("label"))}: ${text(prop("value"))}`]
    case "Switch":
      return [`${text(prop("label"))}: ${prop("value") === true ? "on" : "off"}`]
    case "List":
      return elements(props["rows"])
        .slice(0, LIST_MAX_ITEMS)
        .map((row) => {
          const on = read(row.props["value"])
          const mark = on === undefined ? "-" : `- [${on === true ? "x" : " "}]`
          const detail = text(read(row.props["detail"]))
          const amount = read(row.props["amount"])
          return `${mark} ${text(read(row.props["title"]))}${detail ? ` — ${detail}` : ""}${typeof amount === "number" ? ` (${amount})` : ""}`
        })
    case "Checklist": {
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
    case "Tabs": {
      const picked = prop("value")
      const tabs = elements(props["items"])
      const tab = tabs.find((t) => read(t.props["value"]) === picked) ?? tabs[0]
      if (tab === undefined) return []
      return [
        `${text(read(tab.props["label"]))}:`,
        ...elements(tab.props["children"]).flatMap((child) => partLines(child, read))
      ]
    }
    case "Steps":
      return elements(props["items"])
        .slice(0, LIST_MAX_ITEMS)
        .map((step, i) => {
          const body = text(read(step.props["body"]))
          return `${i + 1}. ${text(read(step.props["title"]))}${body ? ` — ${body}` : ""}`
        })
    case "Gallery":
      return elements(props["photos"]).flatMap((photo) => partLines(photo, read))
    case "Photo":
      return optional(prop("caption"))
    case "Button":
      return [`[Button: ${text(prop("label"))}]`]
    default:
      return []
  }
}

function tableLines(columns: readonly ElementNode[], read: Read): string[] {
  if (columns.length === 0) return []
  const cells = columns.map((col) => {
    const shown = format(read(col.props["format"]), "text")
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

function withUnit(value: unknown, unit: string): string {
  if (unit === "percent") return `${text(value)}%`
  return unit && unit !== "count" ? `${text(value)} ${unit}` : text(value)
}

const isElement = (value: unknown): value is ElementNode =>
  typeof value === "object" &&
  value !== null &&
  (value as { type?: unknown }).type === "element" &&
  typeof (value as { typeName?: unknown }).typeName === "string"

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
