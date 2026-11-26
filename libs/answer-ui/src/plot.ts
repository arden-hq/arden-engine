import { z } from "zod"
import { Format } from "./format.js"
import {
  evaluateFormula,
  FORMULA_READ_KIND,
  FORMULA_VALUE_KIND,
  missingVariables,
  readFormula,
  type FormulaValue
} from "./formula.js"

const Text = z.string().max(200)

export const FormulaVars = z.record(z.string(), z.number())

const PlotSeries = z.object({
  name: Text,
  fn: z.string().max(500),
  vars: FormulaVars.optional()
})

export const PlotSpec = z.object({
  x: z.object({
    from: z.number(),
    to: z.number(),
    step: z.number().positive().optional(),
    label: Text.optional()
  }),
  series: z.array(PlotSeries).min(1).max(4),
  format: Format.optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  height: z.number().optional()
})
export type PlotSpec = z.infer<typeof PlotSpec>

const PLOT_MAX_POINTS = 200
const DEFAULT_POINTS = 61

export const PLOT_DATA_KIND = { plot: "plot", invalid: "invalid" } as const

export type PlotData =
  | {
      readonly kind: typeof PLOT_DATA_KIND.plot
      readonly xs: readonly number[]
      readonly series: ReadonlyArray<{
        readonly name: string
        readonly values: ReadonlyArray<number | undefined>
      }>
    }
  | { readonly kind: typeof PLOT_DATA_KIND.invalid; readonly reason: string }

function plotXs(from: number, to: number, step: number | undefined): number[] {
  const steps = step === undefined ? DEFAULT_POINTS - 1 : Math.floor((to - from) / step + 1e-9)
  if (step === undefined || steps + 1 > PLOT_MAX_POINTS) {
    const count = Math.min(PLOT_MAX_POINTS, steps + 1)
    return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1))
  }
  const xs = Array.from({ length: steps + 1 }, (_, i) => from + i * step)
  const last = xs.at(-1) ?? from
  if (to - last > step * 1e-6) xs.push(to)
  return xs
}

export function plotData(spec: PlotSpec): PlotData {
  const { from, to, step } = spec.x
  if (!(to > from))
    return { kind: PLOT_DATA_KIND.invalid, reason: "x.to must be larger than x.from" }
  const xs = plotXs(from, to, step)
  const series = []
  for (const line of spec.series) {
    const read = readFormula(line.fn)
    if (read.kind === FORMULA_READ_KIND.invalid)
      return { kind: PLOT_DATA_KIND.invalid, reason: `${line.name}: ${read.reason}` }
    const vars = line.vars ?? {}
    const missing = missingVariables(read.formula, [...Object.keys(vars), "x"])
    if (missing.length > 0)
      return {
        kind: PLOT_DATA_KIND.invalid,
        reason: `${line.name}: ${missing.map((name) => `\`${name}\``).join(", ")} not in vars`
      }
    const values = xs.map((x) => {
      const value = evaluateFormula(read.formula, { ...vars, x })
      return value.kind === FORMULA_VALUE_KIND.value ? value.value : undefined
    })
    if (values.every((value) => value === undefined))
      return {
        kind: PLOT_DATA_KIND.invalid,
        reason: `${line.name}: no finite value anywhere on the range`
      }
    series.push({ name: line.name, values })
  }
  return { kind: PLOT_DATA_KIND.plot, xs, series }
}

export function formulaValue(fn: string, vars: Readonly<Record<string, unknown>>): FormulaValue {
  const read = readFormula(fn)
  return read.kind === FORMULA_READ_KIND.formula ? evaluateFormula(read.formula, vars) : read
}
