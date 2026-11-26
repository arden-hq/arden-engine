import { JsonColumnError } from "./json.js"
import { CALL_PLAN, readCallPlan } from "./task-direction.js"
import { TOOL_STATUS } from "./status-sets.js"
import { TOOL_STORE_FAILURE } from "../tools/store.js"
import { PAUSE_REASON, type ToolResult } from "@arden-hq/loop"
import { DateTime, Effect } from "effect"
import {
  ToolExecutionStoreError,
  type ToolApprovalPrompt,
  type ToolExecutionIdentity,
  type ToolExecutionOutcome,
  type ToolExecutionStore
} from "../tools/store.js"
import { approvalPermissionContext } from "./permissions.js"
import { requireLiveWorkflowOwner } from "./detached-workflow-calls.js"
import type { PersistenceDeps } from "./deps.js"
import {
  type UpdatedToolRow,
  toolError,
  preserveToolError,
  decodeIdentity,
  decodeResult,
  loadRow,
  validateRowIdentity,
  requireRow
} from "./tool-rows.js"
import { decodePrompt } from "./tool-approval-drafts.js"
import {
  ensurePendingToolApprovalInTransaction,
  approvalInput,
  setRunPending,
  appendApprovalDraft,
  appendEscalatedApprovalDraft
} from "./tool-approvals.js"
import { settleToolExecutionInTransaction } from "./tool-receipts.js"
import { settleUncertainRow } from "./tool-uncertainty.js"
import { publishLargeToolResult } from "./tool-result-storage.js"
import { ensureMutationReceipt } from "../tools/mutation-receipt.js"
import { stripChangeEvidence } from "../tools/change-evidence.js"

export interface ToolExecutionSettlement {
  readonly admitPlanned: ToolExecutionStore["Service"]["admitPlanned"]
  readonly complete: ToolExecutionStore["Service"]["complete"]
  readonly pause: ToolExecutionStore["Service"]["pause"]
  readonly recover: ToolExecutionStore["Service"]["recover"]
}

export const makeToolExecutionSettlement = ({
  writer,
  chatEvents,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents">): ToolExecutionSettlement => {
  const sql = writer.sql
  const admitPlanned = Effect.fn("SqliteToolExecutionStore.admitPlanned")(function* (
    call: Pick<ToolExecutionIdentity, "runId" | "toolCallId">
  ): Effect.fn.Return<"current" | "needs_review", ToolExecutionStoreError> {
    const plan = yield* readCallPlan(sql, call).pipe(
      Effect.mapError((cause) =>
        cause instanceof JsonColumnError
          ? toolError("admit", "corrupt", "The call's stored plan is unreadable", call, cause)
          : toolError("admit", "storage", "Could not read the call's plan", call, cause)
      )
    )
    if (plan === CALL_PLAN.noCall)
      return yield* toolError("admit", "not_found", "The call was never started", call)
    return plan
  })

  const complete = Effect.fn("SqliteToolExecutionStore.complete")(function* (
    input: ToolExecutionIdentity,
    inputResult: ToolResult
  ): Effect.fn.Return<ToolResult, ToolExecutionStoreError> {
    const identity = yield* decodeIdentity(input, "complete")
    const result = yield* decodeResult(
      identity.changesState
        ? ensureMutationReceipt(identity, stripChangeEvidence(inputResult))
        : stripChangeEvidence(inputResult),
      "complete",
      identity
    )
    const published = yield* writer.withToolResults(publishLargeToolResult(identity, result)).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not save a large tool result outside the database", {
          tool: identity.toolName,
          cause: cause.cause
        }).pipe(Effect.as(undefined))
      )
    )
    const endedAt = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transactInteractive(
        settleToolExecutionInTransaction(sql, input, inputResult, endedAt, { published })
      )
      .pipe(Effect.mapError(preserveToolError("complete", input)))
  })

  const pause = Effect.fn("SqliteToolExecutionStore.pause")(function* (
    input: ToolExecutionIdentity,
    inputPrompt: ToolApprovalPrompt
  ): Effect.fn.Return<void, ToolExecutionStoreError> {
    const identity = yield* decodeIdentity(input, "pause")
    const prompt = yield* decodePrompt(inputPrompt, identity)
    const timestamp = DateTime.formatIso(yield* DateTime.now)
    yield* writer
      .transact(
        Effect.gen(function* () {
          yield* requireLiveWorkflowOwner(sql, identity, "pause")
          const current = yield* requireRow(sql, identity, "pause")
          if (current.status !== TOOL_STATUS.running && current.status !== TOOL_STATUS.paused) {
            return yield* toolError(
              "pause",
              "conflict",
              "Settled tool execution cannot be paused",
              identity
            )
          }
          if (current.status === TOOL_STATUS.running) {
            const updated = yield* sql<UpdatedToolRow>`
            UPDATE tool_calls
            SET status = 'paused', ended_at = ${timestamp}
            WHERE run_id = ${identity.runId} AND tool_call_id = ${identity.toolCallId}
              AND status = 'running'
            RETURNING status
          `.pipe(
              Effect.mapError((cause) =>
                toolError("pause", "storage", "Could not pause tool execution", identity, cause)
              )
            )
            if (updated.length !== 1) {
              return yield* toolError(
                "pause",
                "conflict",
                "Tool execution changed before pause",
                identity
              )
            }
          }
          const permissionContext =
            prompt.reason === PAUSE_REASON.approval
              ? yield* approvalPermissionContext(sql, {
                  runId: identity.runId,
                  toolName: identity.toolName,
                  source: identity.source,
                  data: prompt.data
                }).pipe(
                  Effect.mapError((cause) =>
                    toolError(
                      "pause",
                      cause.reason === TOOL_STORE_FAILURE.invalid
                        ? TOOL_STORE_FAILURE.invalid
                        : TOOL_STORE_FAILURE.storage,
                      cause.message,
                      identity,
                      cause
                    )
                  )
                )
              : null
          const draft = yield* ensurePendingToolApprovalInTransaction(
            sql,
            sessionEvents,
            approvalInput(
              identity,
              "tool_approval",
              prompt.reason,
              prompt.preview ?? prompt.detail ?? null,
              prompt.detail ?? prompt.preview ?? null,
              prompt,
              permissionContext ?? undefined
            ),
            timestamp,
            "pause"
          )
          yield* setRunPending(sql, identity, timestamp, "pause")
          const committed = yield* appendApprovalDraft(
            sql,
            chatEvents,
            identity.sessionId,
            identity,
            "pause",
            draft
          )
          if (draft !== null) {
            yield* appendEscalatedApprovalDraft(sql, chatEvents, identity.sessionId, draft)
          }
          if (committed !== null) {
            yield* sql`
            UPDATE sessions
            SET last_activity = ${timestamp}
            WHERE session_id = ${identity.sessionId}
          `
            yield* sessionEvents.appendInTransaction("session_activity", identity.sessionId)
          }
        })
      )
      .pipe(Effect.mapError(preserveToolError("pause", identity)))
  })

  const recover = Effect.fn("SqliteToolExecutionStore.recover")(function* (
    inputs: ReadonlyArray<ToolExecutionIdentity>
  ): Effect.fn.Return<ReadonlyMap<string, ToolExecutionOutcome>, ToolExecutionStoreError> {
    const identities = yield* Effect.forEach(inputs, (input) => decodeIdentity(input, "recover"))
    const callIds = new Set<string>()
    for (const identity of identities) {
      if (callIds.has(identity.toolCallId)) {
        return yield* toolError(
          "recover",
          "invalid",
          "Recovery contains duplicate tool-call ids",
          identity
        )
      }
      callIds.add(identity.toolCallId)
    }
    if (identities.length === 0) return new Map()

    return yield* writer
      .transact(
        Effect.gen(function* () {
          const recovered = new Map<string, ToolExecutionOutcome>()
          for (const identity of identities) {
            const row = yield* loadRow(sql, identity, "recover")
            if (row === null) continue
            const status = yield* validateRowIdentity(row, identity, "recover")
            if (status !== TOOL_STATUS.paused && status !== TOOL_STATUS.ready) {
              recovered.set(
                identity.toolCallId,
                yield* settleUncertainRow(sql, identity, "recover", { row, status })
              )
            }
          }
          return recovered
        })
      )
      .pipe(Effect.mapError(preserveToolError("recover")))
  })
  return { admitPlanned, complete, pause, recover }
}
