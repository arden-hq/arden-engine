import { decoderFor, makeEncoder } from "../common/boundary.js"
import { Effect, Schema } from "effect"
import {
  ProcessSnapshotSchema,
  ProcessOutputSchema,
  ProcessActionSchema,
  StopProcessRequestSchema
} from "./schema.js"
import type { StopProcessRequest } from "./contracts.js"
export * from "./contracts.js"
export const processDecoders = {
  snapshot: decoderFor(ProcessSnapshotSchema, "Invalid process snapshot"),
  output: decoderFor(ProcessOutputSchema, "Invalid process output"),
  action: decoderFor(ProcessActionSchema, "Invalid process action")
}
export const processRequests = {
  stop: makeEncoder<StopProcessRequest>(
    (input) =>
      Schema.decodeUnknownEffect(StopProcessRequestSchema)(input).pipe(Effect.map(JSON.stringify)),
    "Invalid process stop request"
  )
}
export const processRoutes = {
  snapshot: "/processes",
  stop: "/processes/stop",
  output: (key: string): string => `/processes/output?key=${encodeURIComponent(key)}`
}
