import type { ScriptDetail, ScriptSummary } from "@arden-hq/protocol/workflows"
import { Effect, Schema } from "effect"

import type { ScriptJournal } from "../persistence/scripts/journal.js"
import type { ScriptRecord, ScriptStore, ScriptStoreError } from "../persistence/scripts/store.js"
import type { SessionQueries, SessionQueryFailure } from "../persistence/sessions/queries.js"

export class ScriptAccessError extends Schema.TaggedError<ScriptAccessError>()(
  "ScriptAccessError",
  {
    reason: Schema.Literals(["session_not_found", "wrong_session"] as const),
    message: Schema.String,
    ref: Schema.String,
    sessionId: Schema.String
  }
) {}

export const readOwnedScript = Effect.fn("ScriptAccess.read")(function* (input: {
  readonly store: ScriptStore["Service"]
  readonly sessions: SessionQueries["Service"]
  readonly ref: string
  readonly sessionId: string
  readonly allowedSessionRefs?: ReadonlyArray<string>
}): Effect.fn.Return<ScriptRecord, ScriptAccessError | ScriptStoreError | SessionQueryFailure> {
  const session = yield* input.sessions.loadHistoryHeader(input.sessionId)
  if (session === null) {
    return yield* new ScriptAccessError({
      reason: "session_not_found",
      message: "The script's chat was not found",
      ref: input.ref,
      sessionId: input.sessionId
    })
  }
  const record = yield* input.store.get(input.ref)
  if (
    record.originSessionRef !== session.publicRef &&
    !(input.allowedSessionRefs ?? []).includes(record.originSessionRef)
  ) {
    return yield* new ScriptAccessError({
      reason: "wrong_session",
      message: "The script belongs to another chat",
      ref: input.ref,
      sessionId: input.sessionId
    })
  }
  return record
})

export const scriptSummary = (record: ScriptRecord): ScriptSummary => ({
  workflow_ref: record.ref,
  version: record.version,
  status: record.status,
  attempt: record.attempt,
  origin_session_ref: record.originSessionRef,
  origin_run_id: record.originRunId,
  origin_tool_call_id: record.originToolCallId,
  error: record.error,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
  ended_at: record.endedAt
})

export const scriptDetail = Effect.fn("ScriptAccess.detail")(function* (
  journal: ScriptJournal["Service"],
  record: ScriptRecord
) {
  const agents = yield* journal.agents({
    originRunId: record.originRunId,
    originToolCallId: record.originToolCallId
  })
  return {
    script: scriptSummary(record),
    executions: yield* journal.executions(record),
    agents: agents.map((agent) => ({
      key: agent.key,
      attempts: agent.attempts,
      label: agent.label,
      mode: agent.mode,
      status: agent.status,
      session_ref: agent.sessionRef
    }))
  } satisfies ScriptDetail
})
