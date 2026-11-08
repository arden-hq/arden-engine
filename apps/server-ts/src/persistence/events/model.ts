import { isEphemeralChatEvent } from "@arden-hq/protocol/chat"
import { ChatProjectionEventSchema } from "@arden-hq/protocol/effect/chat"
import { Schema } from "effect"

const EventSequenceSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export const EventCursorSchema = Schema.Natural

const SessionEventRecordSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  sequence: EventSequenceSchema,
  event: ChatProjectionEventSchema,
  runId: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  createdAt: Schema.DateTimeUtc,
  durable: Schema.Boolean
})

export type SessionEventRecord = (typeof SessionEventRecordSchema)["Type"]

const EventDraftSchema = Schema.Struct({
  event: ChatProjectionEventSchema,
  runId: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  admission: Schema.optionalKey(Schema.Literal("detached"))
}).check(
  Schema.makeFilter((draft) =>
    draft.admission === undefined ||
    draft.event.type === "TOOL_CALL_PROGRESS" ||
    draft.event.type === "compaction_finished" ||
    draft.event.type === "approval_needed" ||
    draft.event.type === "approval_resolved" ||
    draft.event.type === "connection_needed" ||
    draft.event.type === "connection_resolved"
      ? []
      : [
          {
            path: ["admission"],
            issue:
              "Detached admission is only valid for tool progress, compaction cleanup, or escalated decisions"
          }
        ]
  )
)

export type EventDraft = (typeof EventDraftSchema)["Type"]

export { isEphemeralChatEvent }

export const isDurableDraft = (draft: EventDraft): boolean =>
  !isEphemeralChatEvent(draft.event) || draft.admission === "detached"

export const CommitEventBatchSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  events: Schema.Array(EventDraftSchema)
}).check(
  Schema.makeFilter((input) => {
    let sawEphemeral = false
    const issues: Array<Schema.FilterIssue> = []
    for (const [index, draft] of input.events.entries()) {
      if (!isDurableDraft(draft)) {
        sawEphemeral = true
      } else if (sawEphemeral) {
        issues.push({
          path: ["events", index, "event", "type"],
          issue: "Structural events must precede live-only events"
        })
      }
    }
    return issues
  })
)

export type CommitEventBatch = (typeof CommitEventBatchSchema)["Type"]

const CommittedEventBatchSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  records: Schema.Array(SessionEventRecordSchema),
  headSequence: EventCursorSchema
})

export type CommittedEventBatch = (typeof CommittedEventBatchSchema)["Type"]

export const EventWatermarksSchema = Schema.Struct({
  headSequence: EventCursorSchema,
  checkpointSequence: EventCursorSchema,
  retainedFromSequence: Schema.NullOr(EventSequenceSchema)
}).check(
  Schema.makeFilter((value) =>
    value.checkpointSequence <= value.headSequence
      ? []
      : [{ path: ["checkpointSequence"], issue: "Checkpoint cannot exceed the journal head" }]
  )
)

export type EventWatermarks = (typeof EventWatermarksSchema)["Type"]

const EventPageSchema = Schema.Struct({
  records: Schema.Array(SessionEventRecordSchema),
  hasMore: Schema.Boolean
})

export type EventPage = (typeof EventPageSchema)["Type"]
