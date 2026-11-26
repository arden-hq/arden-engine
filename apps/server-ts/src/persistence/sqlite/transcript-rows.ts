import { ROLE } from "@arden-hq/std/message-vocabulary"
import { agentResultPresentation } from "./agent-result-presentation.js"
import { Effect, Schema } from "effect"
import { type TranscriptRow } from "./transcript-tool-result.js"
import { TranscriptDataCorruptionError, TranscriptQueryError } from "../transcript/queries.js"
import {
  TranscriptMessageRecordSchema,
  StoredMessageEnvelopeSchema,
  type TranscriptMessageRecord
} from "../transcript/model.js"
import type { PersistenceDeps } from "./deps.js"
import { decodeJson } from "./json.js"

export interface CountRow {
  readonly count: number
}

export interface SequenceRow {
  readonly seq: number
}

export interface TurnIdRow {
  readonly turn_id: string
}

export interface TurnOriginRow {
  readonly turn_id: string
  readonly origin_json: string
}

export const queryError = (
  operation: "resolve" | "page",
  sessionId: string,
  message: string,
  cause?: unknown
): TranscriptQueryError =>
  new TranscriptQueryError({
    operation,
    sessionId,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export const corruption = (
  sessionId: string,
  message: string,
  cause?: unknown
): TranscriptDataCorruptionError =>
  new TranscriptDataCorruptionError({
    sessionId,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export type DecodeRow = (
  row: TranscriptRow
) => Effect.Effect<TranscriptMessageRecord, TranscriptDataCorruptionError>

export const makeDecodeRow = (sql: PersistenceDeps["reader"]): DecodeRow => {
  const decodeRow = Effect.fn("SqliteTranscriptQueries.decodeRow")(function* (row: TranscriptRow) {
    const envelope = yield* decodeJson(StoredMessageEnvelopeSchema, row.message_json).pipe(
      Effect.mapError((cause) =>
        corruption(row.session_id, "Transcript message JSON is corrupt", cause)
      )
    )
    const agentResult =
      row.role === ROLE.interaction
        ? yield* agentResultPresentation(sql, row.session_id, row.message_id).pipe(
            Effect.mapError((cause) =>
              corruption(row.session_id, "Could not read agent result", cause)
            )
          )
        : undefined
    const createdAt = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
      row.created_at
    ).pipe(
      Effect.mapError((cause) =>
        corruption(row.session_id, "Transcript message timestamp is corrupt", cause)
      )
    )
    return yield* Schema.decodeUnknownEffect(TranscriptMessageRecordSchema)({
      sessionId: row.session_id,
      messageId: row.message_id,
      sequence: row.seq,
      role: row.role,
      clientId: row.client_id,
      createdAt,
      envelope: agentResult === undefined ? envelope : { ...envelope, agent_result: agentResult }
    }).pipe(
      Effect.mapError((cause) =>
        corruption(row.session_id, "Transcript message row is corrupt", cause)
      )
    )
  })
  return decodeRow
}
