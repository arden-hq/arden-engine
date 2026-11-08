import type { ToolApprovalPrompt, ToolResult } from "@arden-hq/loop"
import { DateTime, Effect, Option, Schema } from "effect"
import type { ApprovalPresentation } from "@arden-hq/protocol/chat"
import { JsonObjectSchema } from "../json.js"
import {
  DeferredToolCalls,
  type DeferredDecision,
  type DeferredDecisionInput,
  type DeferredToolCall
} from "../tools/deferred.js"
import type { PersistenceDeps } from "./deps.js"
import { encodeJson } from "./json.js"
import { journalAskChange } from "./ask-changes.js"
import {
  appendEscalatedApprovalDraft,
  approvalInput,
  approvalPayload,
  cardStanding,
  pendingDecisionDraft
} from "./tool-approvals.js"
import { PersistedToolResultSchema, decodeResult, toolError } from "./tool-rows.js"
import { assertRunTaskBinding } from "./run-context.js"
import { noApprovalForRun } from "./approval-policy.js"
import { loadPendingDecisionRoutes } from "./decision-route-journal.js"
import { COMMAND_TOOL } from "../permissions/command-policy.js"
import { approvalPermissionContext } from "./permissions.js"
import { saveCardRule } from "./tool-approval-resolve.js"
import { followUpRecordableStatusList } from "./status-sets.js"

interface DeferredRow {
  readonly run_id: string
  readonly session_id: string
  readonly tool_call_id: string
  readonly tool_name: string
  readonly arguments_json: string
  readonly changes_state: number
  readonly payload_json: string
  readonly status: string
}

const decodeObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObjectSchema))

const deferredCall = (row: DeferredRow): DeferredToolCall | undefined => {
  const args = Option.getOrUndefined(decodeObject(row.arguments_json))
  const payload = Option.getOrUndefined(decodeObject(row.payload_json))
  if (args === undefined || payload === undefined) return undefined
  const data = Option.getOrUndefined(
    Schema.decodeUnknownOption(JsonObjectSchema)(payload["approval_data"])
  )
  const savedIn = payload["saved_in"]
  const standing = cardStanding({ granted: savedIn !== undefined, data, savedIn })
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    arguments: args,
    changesState: row.changes_state === 1,
    data: standing.data,
    ...(standing.grantStanding === undefined ? {} : { grantStanding: standing.grantStanding })
  }
}

export const makeDeferredToolCalls = ({
  writer,
  sessionEvents,
  chatEvents
}: Pick<
  PersistenceDeps,
  "writer" | "sessionEvents" | "chatEvents"
>): DeferredToolCalls["Service"] => {
  const sql = writer.sql

  const defer = Effect.fn("DeferredToolCalls.defer")(function* (input: {
    readonly call: DeferredToolCall
    readonly prompt: ToolApprovalPrompt<ApprovalPresentation>
  }) {
    const { call, prompt } = input
    const identity = { runId: call.runId, toolCallId: call.toolCallId }
    const permission =
      call.toolName === COMMAND_TOOL
        ? yield* approvalPermissionContext(sql, {
            runId: call.runId,
            toolName: call.toolName,
            source: undefined,
            data: prompt.data
          }).pipe(
            Effect.mapError((cause) =>
              toolError("pause", "storage", cause.message, identity, cause)
            )
          )
        : null
    const card = approvalInput(
      {
        runId: call.runId,
        sessionId: call.sessionId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        arguments: call.arguments,
        changesState: call.changesState
      },
      "tool_approval",
      "approval",
      prompt.preview ?? null,
      prompt.preview ?? null,
      prompt,
      permission ?? undefined
    )
    const payload = yield* encodeJson(JsonObjectSchema, approvalPayload(card)).pipe(
      Effect.mapError((cause) =>
        toolError("pause", "corrupt", "Deferred card payload is invalid", identity, cause)
      )
    )
    const args = yield* encodeJson(JsonObjectSchema, call.arguments).pipe(
      Effect.mapError((cause) =>
        toolError("pause", "corrupt", "Deferred call arguments are invalid", identity, cause)
      )
    )
    const draft = yield* pendingDecisionDraft(card, "pause", "deferred")
    const at = DateTime.formatIso(yield* DateTime.now)
    yield* writer
      .transact(
        Effect.gen(function* () {
          const inserted = yield* sql`INSERT INTO deferred_tool_calls (run_id, session_id,
            tool_call_id, tool_name, action, scope, preview, diff, payload_json, arguments_json,
            changes_state, status, requested_at)
          VALUES (${call.runId}, ${call.sessionId}, ${call.toolCallId}, ${call.toolName},
            ${card.action}, ${card.scope}, ${card.preview}, ${card.diff ?? null}, ${payload},
            ${args}, ${call.changesState ? 1 : 0}, 'pending', ${at})
          ON CONFLICT (run_id, tool_call_id) DO NOTHING RETURNING tool_call_id`
          if (inserted.length === 0) return
          const routes = yield* loadPendingDecisionRoutes(
            sql,
            "deferred",
            call.runId,
            call.toolCallId
          )
          yield* appendEscalatedApprovalDraft(sql, chatEvents, call.sessionId, draft, routes, true)
          yield* journalAskChange(sql, sessionEvents, {
            kind: "approval_opened",
            runId: call.runId,
            sessionId: call.sessionId,
            toolCallId: call.toolCallId,
            toolName: call.toolName
          })
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          toolError("pause", "storage", "Could not keep the deferred card", identity, cause)
        )
      )
  })

  const decideInTransaction = makeDeferredDecisionInTransaction({ sql, sessionEvents })
  const decide: DeferredToolCalls["Service"]["decide"] = (input) =>
    writer
      .transact(decideInTransaction(input))
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "ToolExecutionStoreError"
            ? cause
            : toolError(
                "resolve",
                "storage",
                "Could not decide the deferred card",
                { runId: input.runId, toolCallId: input.toolCallId },
                cause
              )
        )
      )

  const approvedUnrun = Effect.fn("DeferredToolCalls.approvedUnrun")(function* () {
    const rows = yield* sql<DeferredRow>`SELECT run_id, session_id, tool_call_id, tool_name,
        arguments_json, changes_state, payload_json, status
      FROM deferred_tool_calls WHERE status = 'approved'
      ORDER BY resolved_at, run_id, tool_call_id`.pipe(
      Effect.mapError((cause) =>
        toolError("recover", "storage", "Could not list approved deferred calls", undefined, cause)
      )
    )
    return rows.flatMap((row) => deferredCall(row) ?? [])
  })

  const rejectSidePending = Effect.fn("DeferredToolCalls.rejectSidePending")(function* () {
    const rows = yield* sql<{ readonly run_id: string; readonly tool_call_id: string }>`
      SELECT run_id, tool_call_id FROM deferred_tool_calls
      WHERE status = 'pending' ORDER BY requested_at, run_id, tool_call_id`.pipe(
      Effect.mapError((cause) =>
        toolError("recover", "storage", "Could not list older Side chat cards", undefined, cause)
      )
    )
    for (const row of rows) {
      const noApproval = yield* noApprovalForRun(sql, row.run_id).pipe(
        Effect.mapError((cause) =>
          toolError(
            "recover",
            "storage",
            "Could not inspect older Side chat card",
            undefined,
            cause
          )
        )
      )
      if (!noApproval) continue
      yield* decide({
        runId: row.run_id,
        toolCallId: row.tool_call_id,
        approved: false,
        result: ""
      })
    }
  })

  const recordRun = Effect.fn("DeferredToolCalls.recordRun")(function* (input: {
    readonly runId: string
    readonly toolCallId: string
    readonly result: ToolResult
  }) {
    const identity = { runId: input.runId, toolCallId: input.toolCallId }
    const persisted = yield* decodeResult(input.result, "complete", identity)
    const result = yield* encodeJson(PersistedToolResultSchema, persisted).pipe(
      Effect.mapError((cause) =>
        toolError("complete", "corrupt", "The follow-up result is invalid", identity, cause)
      )
    )
    yield* writer
      .transact(
        sql`UPDATE deferred_tool_calls SET status = 'ran', result_json = ${result}
        WHERE run_id = ${input.runId} AND tool_call_id = ${input.toolCallId}
          AND status IN ${followUpRecordableStatusList}
          AND result_json IS NULL`
      )
      .pipe(
        Effect.mapError((cause) =>
          toolError("complete", "storage", "Could not record the follow-up", identity, cause)
        )
      )
  })

  return DeferredToolCalls.of({ defer, decide, approvedUnrun, rejectSidePending, recordRun })
}

const keepCardRule = Effect.fn("DeferredToolCalls.keepCardRule")(function* (
  sql: PersistenceDeps["writer"]["sql"],
  row: DeferredRow,
  grantList: DeferredDecisionInput["grantList"]
) {
  const identity = { runId: row.run_id, toolCallId: row.tool_call_id }
  const payload = Option.getOrUndefined(decodeObject(row.payload_json))
  if (payload === undefined)
    return yield* toolError("resolve", "corrupt", "The deferred card is unreadable", identity)
  const saved = yield* saveCardRule(sql, {
    approval: row,
    payload,
    decision: { ...identity, grantList }
  })
  if (saved === null) return row
  const stored = yield* encodeJson(JsonObjectSchema, { ...payload, saved_in: saved }).pipe(
    Effect.mapError((cause) =>
      toolError("resolve", "corrupt", "Deferred card payload is invalid", identity, cause)
    )
  )
  yield* sql`UPDATE deferred_tool_calls SET payload_json = ${stored}
    WHERE run_id = ${row.run_id} AND tool_call_id = ${row.tool_call_id}`
  return { ...row, payload_json: stored }
})

export const makeDeferredDecisionInTransaction = ({
  sql,
  sessionEvents
}: {
  readonly sql: PersistenceDeps["writer"]["sql"]
  readonly sessionEvents: PersistenceDeps["sessionEvents"]
}) =>
  Effect.fn("DeferredToolCalls.decideInTransaction")(function* (input: DeferredDecisionInput) {
    const identity = { runId: input.runId, toolCallId: input.toolCallId }
    const at = DateTime.formatIso(yield* DateTime.now)
    const rows = yield* sql<DeferredRow>`SELECT run_id, session_id, tool_call_id, tool_name,
  arguments_json, changes_state, payload_json, status
FROM deferred_tool_calls
WHERE run_id = ${input.runId} AND tool_call_id = ${input.toolCallId}`
    const row = rows[0]
    if (row === undefined) return { kind: "not_deferred" } satisfies DeferredDecision
    if (input.approved === undefined)
      return yield* toolError(
        "resolve",
        "conflict",
        "Choose approve or reject for this deferred card; it is still pending",
        identity
      )
    if (input.editedArguments !== undefined)
      return yield* toolError(
        "resolve",
        "conflict",
        "This deferred card cannot apply edited arguments; it is still pending",
        identity
      )
    if (input.alternative !== undefined)
      return yield* toolError(
        "resolve",
        "conflict",
        "This deferred card cannot save an alternative draft; it is still pending",
        identity
      )
    if (
      (input.grantStanding === true &&
        (input.approved !== true || row.tool_name !== COMMAND_TOOL)) ||
      input.attachFolderToSpace === true
    )
      return yield* toolError(
        "resolve",
        "conflict",
        "This deferred card cannot grant standing or folder access; it is still pending",
        identity
      )
    if (input.result.trim().length > 0)
      return yield* toolError(
        "resolve",
        "conflict",
        "This deferred card cannot deliver feedback to its completed run; it is still pending",
        identity
      )
    if (row.status !== "pending") {
      const same = (row.status === "rejected") === !input.approved
      if (!same)
        return yield* toolError(
          "resolve",
          "conflict",
          "This card was already decided the other way",
          identity
        )
      return { kind: "settled" } satisfies DeferredDecision
    }
    if (input.approved && (yield* noApprovalForRun(sql, row.run_id))) {
      return yield* toolError(
        "resolve",
        "conflict",
        "Side chats cannot approve pending tool calls; reject this card or close the Side chat",
        identity
      )
    }
    if (input.approved)
      yield* assertRunTaskBinding(sql, row.run_id).pipe(
        Effect.mapError((cause) =>
          toolError(
            "resolve",
            "conflict",
            "This card's Run no longer has authority to execute the call",
            identity,
            cause
          )
        )
      )
    yield* sql`UPDATE deferred_tool_calls
  SET status = ${input.approved ? "approved" : "rejected"}, resolved_at = ${at}
  WHERE run_id = ${row.run_id} AND tool_call_id = ${row.tool_call_id}
    AND status = 'pending'`
    yield* sql`UPDATE sessions SET last_activity = ${at}
  WHERE session_id = ${row.session_id}`
    yield* sessionEvents.appendInTransaction("session_activity", row.session_id)
    if (!input.approved) return { kind: "settled" } satisfies DeferredDecision
    const call = deferredCall(
      input.grantStanding === true ? yield* keepCardRule(sql, row, input.grantList) : row
    )
    if (call === undefined)
      return yield* toolError("resolve", "corrupt", "The deferred call is unreadable", identity)
    return { kind: "approved", call } satisfies DeferredDecision
  })
