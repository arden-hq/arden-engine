import { z } from "zod"

export const FORMAT = {
  usd: "usd",
  jpy: "jpy",
  number: "number",
  percent: "percent",
  text: "text"
} as const
export type Format = (typeof FORMAT)[keyof typeof FORMAT]
export const Format = z.enum(FORMAT)

type NumberFormat = Exclude<Format, typeof FORMAT.text>

export const isFormat = (value: unknown): value is Format => Format.safeParse(value).success

const FORMATS: Record<NumberFormat, Intl.NumberFormatOptions> = {
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

export function formatFigure(value: unknown, format: Format): string {
  const n = figureNumber(value)
  if (format === FORMAT.text || !Number.isFinite(n)) return String(value ?? "")
  const options = format === FORMAT.usd && Math.abs(n) < 100 ? USD_CENTS : FORMATS[format]
  return new Intl.NumberFormat("en-US", options).format(format === FORMAT.percent ? n / 100 : n)
}

const AXIS: Record<NumberFormat, Intl.NumberFormatOptions> = {
  usd: { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 },
  jpy: { style: "currency", currency: "JPY", notation: "compact", maximumFractionDigits: 1 },
  number: { notation: "compact", maximumFractionDigits: 1 },
  percent: { style: "percent", maximumFractionDigits: 1 }
}

export function formatAxis(value: number, format: Format): string {
  if (!Number.isFinite(value)) return ""
  const options = AXIS[format === FORMAT.text ? FORMAT.number : format]
  return new Intl.NumberFormat("en-US", options).format(
    format === FORMAT.percent ? value / 100 : value
  )
}
