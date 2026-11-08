import { JobPurposeSchema } from "../job-classification.js"
import { SessionTypeSchema } from "@arden-hq/protocol/effect/common"
import { Schema } from "effect"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import { AutomationId } from "../automations/model.js"
import { StoredMessageEnvelopeSchema } from "../transcript/model.js"
import { SessionForkOriginSchema } from "@arden-hq/protocol/effect/common"

export const SessionHistoryHeaderSchema = Schema.Struct({
  originJobPurpose: Schema.NullOr(JobPurposeSchema),
  sessionId: Schema.NonEmptyString,
  publicRef: Schema.NonEmptyString,
  startedAt: Schema.DateTimeUtc,
  lastActivity: Schema.DateTimeUtc,
  name: Schema.NullOr(Schema.String),
  sessionType: SessionTypeSchema,
  originAutomationId: Schema.NullOr(AutomationId),
  parentSessionId: Schema.NullOr(Schema.NonEmptyString),
  parentRunId: Schema.NullOr(Schema.NonEmptyString),
  parentToolCallId: Schema.NullOr(Schema.NonEmptyString),
  parentMessageId: Schema.NullOr(Schema.NonEmptyString),
  spaceId: Schema.NullOr(Schema.NonEmptyString),
  chatModel: Schema.NullOr(Schema.NonEmptyString),
  activeMessageCount: Schema.Natural,
  lastInputTokens: Schema.NullOr(Schema.Natural),
  contextGeneration: Schema.Natural,
  forkOrigin: Schema.optionalKey(SessionForkOriginSchema)
})

export type SessionHistoryHeader = (typeof SessionHistoryHeaderSchema)["Type"]

export const AgentChildReferenceSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  publicRef: Schema.NonEmptyString,
  name: Schema.NullOr(Schema.String),
  purpose: Schema.NullOr(Schema.String),
  parentRunId: Schema.NullOr(Schema.NonEmptyString),
  parentToolCallId: Schema.NullOr(Schema.NonEmptyString)
})

export type AgentChildReference = (typeof AgentChildReferenceSchema)["Type"]

export interface SessionNameImage {
  readonly mediaType: "image/png" | "image/jpeg"
  readonly data: string
}

export interface SessionNameSeed {
  readonly text: string
  readonly images: ReadonlyArray<SessionNameImage>
}

export interface SessionHeaderSnapshot {
  readonly header: SessionHistoryHeader
  readonly metadata: JsonObject
}

export const ActiveSessionSnapshotSchema = Schema.Struct({
  header: SessionHistoryHeaderSchema,
  messages: Schema.Array(StoredMessageEnvelopeSchema),
  metadata: JsonObjectSchema
}).check(
  Schema.makeFilter((snapshot) =>
    snapshot.header.activeMessageCount === snapshot.messages.length
      ? undefined
      : {
          path: ["header", "activeMessageCount"],
          issue: "must equal the active message count"
        }
  )
)

export type ActiveSessionSnapshot = (typeof ActiveSessionSnapshotSchema)["Type"]
