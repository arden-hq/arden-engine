import { Effect, Schema } from "effect"
import { decoderFor, makeEncoder } from "../common/boundary.js"
import {
  BrowserProcedureSummarySchema,
  BrowserProcedureDetailSchema,
  BrowserProcedureListSchema,
  BrowserProcedureEnabledSchema,
  BrowserProcedureMutationSchema
} from "./schema.js"

export type BrowserProcedureSummary = typeof BrowserProcedureSummarySchema.Type
export type BrowserProcedureDetail = typeof BrowserProcedureDetailSchema.Type
export type BrowserProcedureList = typeof BrowserProcedureListSchema.Type
export const browserProcedureDecoders = {
  list: decoderFor(BrowserProcedureListSchema, "Invalid browser procedures"),
  detail: decoderFor(BrowserProcedureDetailSchema, "Invalid browser procedure"),
  mutation: decoderFor(BrowserProcedureMutationSchema, "Invalid browser procedure change")
}
export const browserProcedureRequests = {
  setEnabled: makeEncoder<{ readonly enabled: boolean }>(
    (input) =>
      Schema.decodeUnknownEffect(BrowserProcedureEnabledSchema)(input).pipe(
        Effect.map(JSON.stringify)
      ),
    "Invalid browser procedure setting"
  )
}
export const browserProcedureRoutes = {
  list: "/browser-procedures",
  settings: "/browser-procedures/settings",
  detail: (id: string): string => `/browser-procedures/${encodeURIComponent(id)}`,
  procedure: (id: string): string => `/browser-procedures/${encodeURIComponent(id)}`
}
