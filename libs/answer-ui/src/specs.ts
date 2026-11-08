import { z } from "zod"

const Text = z.string().max(200)
const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()])
const Tone = z.number().int().min(1).max(6)
const Time = z.union([z.string(), z.number()])

const Reference = z.object({
  value: z.number(),
  to: z.number().describe("Upper end: shades the band from value to to.").optional(),
  label: Text.optional()
})

const Series = z.object({
  name: Text,
  values: z
    .array(
      z.union([
        z.number(),
        z.null(),
        z.object({ x: z.number(), y: z.number(), label: Text.optional() })
      ])
    )
    .describe("One value per label, null where missing. Scatter: {x, y, label} points.")
})

const TimelineItem = z.object({
  label: Text,
  start: Time.describe("ISO date-time in the user's local time, or a number."),
  end: Time.describe("Omit for a milestone.").optional(),
  lane: Text.describe("Items with the same lane share a row.").optional(),
  tone: Tone.optional()
})

const CHART_KINDS = [
  "bar",
  "hbar",
  "line",
  "area",
  "scatter",
  "histogram",
  "heatmap",
  "timeline"
] as const

const ChartFields = z.object({
  kind: z.enum(CHART_KINDS),
  title: Text.optional(),
  data: z
    .array(z.record(z.string(), Cell))
    .max(5_000)
    .describe("Rows as you have them. Name the fields with x, y, group and value.")
    .optional(),
  x: Text.describe(
    "Field with the labels (category, date, or x for scatter and histogram)."
  ).optional(),
  y: z
    .union([Text, z.array(Text)])
    .describe(
      "Value field, or several for several series. Default: every other field. Heatmap: the row field."
    )
    .optional(),
  group: Text.describe(
    "Field whose values become the series (long format, one value per row)."
  ).optional(),
  value: Text.describe("Heatmap: the field with each cell's value.").optional(),
  label: Text.describe("Scatter: the field naming each point.").optional(),
  labels: z.array(z.union([z.string(), z.number()])).optional(),
  series: z.array(Series).max(6).optional(),
  values: z
    .array(z.union([z.number(), z.null(), z.array(z.union([z.number(), z.null()]))]))
    .describe("Histogram: raw numbers. Heatmap: one array per row, null where missing.")
    .optional(),
  rows: z.array(Text).describe("Heatmap row labels.").optional(),
  columns: z.array(Text).describe("Heatmap column labels.").optional(),
  items: z.array(TimelineItem).max(200).optional(),
  now: z.union([z.boolean(), Time]).describe("Timeline: mark the present.").optional(),
  bins: z.number().int().min(3).max(40).optional(),
  stacked: z.boolean().describe("bar and hbar: parts of a whole.").optional(),
  references: z
    .array(Reference)
    .max(3)
    .describe("Goal, budget or limit lines or bands.")
    .optional(),
  xLabel: Text.optional(),
  yLabel: Text.optional(),
  prefix: Text.describe('Before every number, such as "$".').optional(),
  suffix: Text.describe('After every number, such as " ms" or "%".').optional()
})

export type ChartSpec = z.infer<typeof ChartFields>

/** A chart spec, with the rules that tie its fields together (a field named
 *  by x must exist in data, a heatmap's rows match its values, …). */
export const ChartSpec = ChartFields.superRefine((spec, ctx) => {
  const problem = chartProblem(spec)
  if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem })
})

function chartProblem(spec: ChartSpec): string | undefined {
  const rows = spec.data !== undefined
  const fields = new Set(spec.data?.flatMap((row) => Object.keys(row)))
  for (const key of ["x", "group", "value", "label"] as const) {
    const field = spec[key]
    if (rows && field !== undefined && !fields.has(field))
      return `${key} "${field}" is not a field of data`
  }
  for (const field of typeof spec.y === "string" ? [spec.y] : (spec.y ?? [])) {
    if (rows && !fields.has(field)) return `y "${field}" is not a field of data`
  }
  switch (spec.kind) {
    case "timeline":
      return spec.items !== undefined || rows ? undefined : "timeline needs items"
    case "histogram":
      if (rows) return spec.x === undefined ? "histogram data needs x: the field to bin" : undefined
      return spec.values?.every((value) => typeof value === "number")
        ? undefined
        : "histogram needs values: an array of numbers, or data with x"
    case "heatmap":
      if (rows) {
        return spec.x !== undefined && typeof spec.y === "string" && spec.value !== undefined
          ? undefined
          : "heatmap data needs x (column field), y (row field) and value"
      }
      if (spec.rows === undefined || spec.columns === undefined || spec.values === undefined)
        return "heatmap needs rows, columns and values (one array per row), or data with x, y, value"
      return spec.values.length === spec.rows.length &&
        spec.values.every((row) => Array.isArray(row) && row.length === spec.columns?.length)
        ? undefined
        : "heatmap values must have one array per row, each as long as columns"
    case "scatter":
      if (rows)
        return spec.x !== undefined && spec.y !== undefined
          ? undefined
          : "scatter data needs x and y"
      return spec.series !== undefined
        ? undefined
        : "scatter needs series of {x, y} points, or data with x and y"
    case "bar":
    case "hbar":
    case "line":
    case "area":
      if (rows) {
        if (spec.x === undefined) return `${spec.kind} data needs x: the label field`
        if (spec.group !== undefined && typeof spec.y !== "string")
          return "with group, y must name the one value field"
        return undefined
      }
      if (spec.series === undefined) return `${spec.kind} needs data with x, or labels with series`
      return spec.series.every(
        (series) => series.values.length <= (spec.labels?.length ?? Infinity)
      )
        ? undefined
        : "a series has more values than there are labels"
  }
}

const Node = z.object({
  id: Text,
  label: Text.describe("Defaults to the id. Keep it short; two lines at most.").optional(),
  note: Text.describe("One short secondary line.").optional(),
  group: Text.describe("Group id; members are drawn inside one labelled box.").optional(),
  tone: Tone.describe("Series tint for a meaning such as what changed.").optional(),
  muted: z.boolean().describe("External or secondary actor.").optional()
})

const Edge = z.object({
  from: Text,
  to: Text,
  label: Text.optional(),
  style: z
    .enum(["dashed", "strong"])
    .describe("dashed: optional, async or later. strong: the path that matters.")
    .optional(),
  both: z.boolean().describe("Arrows at both ends.").optional()
})

const DiagramFields = z.object({
  title: Text.optional(),
  direction: z
    .enum(["down", "right"])
    .describe("Flow direction. Default down, which fits the chat best.")
    .optional(),
  nodes: z
    .array(Node)
    .max(40)
    .describe("Optional: an id used only in edges becomes a node.")
    .optional(),
  edges: z.array(Edge).max(80),
  groups: z.array(z.object({ id: Text, label: Text.optional(), tone: Tone.optional() })).optional()
})

export type DiagramSpec = z.infer<typeof DiagramFields>

/** A diagram spec: nodes and edges, at most 40 nodes in all. */
export const DiagramSpec = DiagramFields.superRefine((spec, ctx) => {
  if ((spec.nodes?.length ?? 0) === 0 && spec.edges.length === 0) {
    ctx.addIssue({ code: "custom", message: "a diagram needs nodes or edges" })
    return
  }
  const ids = new Set([
    ...(spec.nodes ?? []).map((node) => node.id),
    ...spec.edges.flatMap((edge) => [edge.from, edge.to])
  ])
  if (ids.size > 40)
    ctx.addIssue({
      code: "custom",
      message: "at most 40 nodes; split it into two diagrams or group the detail"
    })
})
