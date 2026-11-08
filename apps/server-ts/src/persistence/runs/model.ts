import { RuntimeRunStatusSchema } from "@arden-hq/protocol/effect/common"
import { DateTime, Schema } from "effect"
import { EventCursorSchema } from "../events/model.js"
import { JsonObjectSchema } from "../json.js"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"

const ChatRunRecordFields = Schema.Struct({
  runId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  turnId: Schema.NonEmptyString,
  status: RuntimeRunStatusSchema,
  stopReason: Schema.NullOr(Schema.NonEmptyString),
  startedAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  endedAt: Schema.NullOr(Schema.DateTimeUtc),
  lastSequence: Schema.NullOr(EventCursorSchema),
  metadata: JsonObjectSchema,
  errorCode: Schema.NullOr(Schema.NonEmptyString),
  errorMessage: Schema.NullOr(Schema.String),
  clientId: Schema.NullOr(Schema.NonEmptyString),
  modelId: Schema.NullOr(Schema.NonEmptyString),
  reasoningEffort: Schema.NullOr(Schema.NonEmptyString)
})

export const ChatRunRecordSchema = ChatRunRecordFields.check(
  Schema.makeFilter((run) => {
    const issues: Array<Schema.FilterIssue> = []
    const active = isActiveRunStatus(run.status)
    if (active && run.endedAt !== null) {
      issues.push({ path: ["endedAt"], issue: "must be null for an active run" })
    }
    if (!active && run.endedAt === null) {
      issues.push({ path: ["endedAt"], issue: "is required for a terminal or interrupted run" })
    }
    if (active && run.stopReason !== null) {
      issues.push({ path: ["stopReason"], issue: "must be null for an active run" })
    }
    if (active && (run.errorCode !== null || run.errorMessage !== null)) {
      issues.push({ path: ["errorCode"], issue: "must be null for an active run" })
    }
    if ((run.errorCode === null) !== (run.errorMessage === null)) {
      issues.push({
        path: ["errorCode"],
        issue: "must be present exactly when errorMessage is present"
      })
    }
    if (run.status === "interrupted" && run.stopReason === null) {
      issues.push({ path: ["stopReason"], issue: "is required for an interrupted run" })
    }
    if (run.status === "completed" && (run.errorCode !== null || run.errorMessage !== null)) {
      issues.push({ path: ["errorCode"], issue: "completed runs cannot contain an error" })
    }
    if (run.status === "error" && (run.errorCode === null || run.errorMessage === null)) {
      issues.push({ path: ["errorCode"], issue: `${run.status} requires a structured error` })
    }
    if (run.status === "cancelled" && (run.errorCode !== null || run.errorMessage !== null)) {
      issues.push({ path: ["errorCode"], issue: "cancelled runs cannot contain an error" })
    }
    const startedAt = DateTime.toEpochMillis(run.startedAt)
    const updatedAt = DateTime.toEpochMillis(run.updatedAt)
    if (updatedAt < startedAt) {
      issues.push({ path: ["updatedAt"], issue: "must not precede startedAt" })
    }
    if (run.endedAt !== null) {
      const endedAt = DateTime.toEpochMillis(run.endedAt)
      if (endedAt < startedAt || endedAt > updatedAt) {
        issues.push({ path: ["endedAt"], issue: "must be between startedAt and updatedAt" })
      }
    }
    return issues
  })
)

export type ChatRunRecord = (typeof ChatRunRecordSchema)["Type"]
