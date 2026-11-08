import { z } from "zod"

/** How a figure is written: money, a plain number, a percent of 100, or as given. */
const FORMAT_NAMES = ["usd", "jpy", "number", "percent", "text"] as const
export type Format = (typeof FORMAT_NAMES)[number]
export const Format = z.enum(FORMAT_NAMES)

export const isFormat = (value: unknown): value is Format => Format.safeParse(value).success

const FORMATS: Record<Exclude<Format, "text">, Intl.NumberFormatOptions> = {
  usd: { style: "currency", currency: "USD", maximumFractionDigits: 0 },
  jpy: { style: "currency", currency: "JPY", maximumFractionDigits: 0 },
  number: { maximumFractionDigits: 1 },
  percent: { style: "percent", maximumFractionDigits: 0 }
}
const USD_CENTS: Intl.NumberFormatOptions = {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
}

const figureNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : Number(value)

/** A figure as its format writes it: money, a number, a percent of 100. Text,
 *  and a value that is not a number, read as given. The block draws and the
 *  block's plain text write a figure the same way. */
export function formatFigure(value: unknown, format: Format): string {
  const n = figureNumber(value)
  if (format === "text" || !Number.isFinite(n)) return String(value ?? "")
  const options = format === "usd" && Math.abs(n) < 100 ? USD_CENTS : FORMATS[format]
  return new Intl.NumberFormat("en-US", options).format(format === "percent" ? n / 100 : n)
}

const AXIS: Record<Exclude<Format, "text">, Intl.NumberFormatOptions> = {
  usd: { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 },
  jpy: { style: "currency", currency: "JPY", notation: "compact", maximumFractionDigits: 1 },
  number: { notation: "compact", maximumFractionDigits: 1 },
  percent: { style: "percent", maximumFractionDigits: 1 }
}

/** A number on a chart axis: short ($120K, 1.5M, 5%), so a tick label keeps
 *  about the same width as the values under it change. */
export function formatAxis(value: number, format: Format): string {
  if (!Number.isFinite(value)) return ""
  const options = AXIS[format === "text" ? "number" : format]
  return new Intl.NumberFormat("en-US", options).format(format === "percent" ? value / 100 : value)
}
