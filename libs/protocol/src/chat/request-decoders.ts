import { Schema } from "effect"
import type { Effect } from "effect"
import {
  ChatRequestSchema,
  ToolResultRequestSchema,
  ConnectionResultRequestSchema,
  CancelRequestSchema,
  HistoryQuerySchema,
  MarkSessionReadResponseSchema
} from "./schema.js"

type Decoded<S extends Schema.Decoder<unknown>> = Effect.Effect<S["Type"], Schema.SchemaError>

export const decodeChatRequestEffect = (value: unknown): Decoded<typeof ChatRequestSchema> =>
  Schema.decodeUnknownEffect(ChatRequestSchema)(value)

export const decodeToolResultRequestEffect = (
  value: unknown
): Decoded<typeof ToolResultRequestSchema> =>
  Schema.decodeUnknownEffect(ToolResultRequestSchema)(value)

export const decodeConnectionResultRequestEffect = (
  value: unknown
): Decoded<typeof ConnectionResultRequestSchema> =>
  Schema.decodeUnknownEffect(ConnectionResultRequestSchema)(value)

export const decodeCancelRequestEffect = (value: unknown): Decoded<typeof CancelRequestSchema> =>
  Schema.decodeUnknownEffect(CancelRequestSchema)(value)

export const decodeHistoryQueryEffect = (value: unknown): Decoded<typeof HistoryQuerySchema> =>
  Schema.decodeUnknownEffect(HistoryQuerySchema)(value)

export const decodeMarkSessionReadResponseEffect = (
  value: unknown
): Decoded<typeof MarkSessionReadResponseSchema> =>
  Schema.decodeUnknownEffect(MarkSessionReadResponseSchema)(value)
