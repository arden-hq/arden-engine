import { readRunAuthority } from "./run-context.js"
import { TaskDirectionReceiptSchema, type ToolCallPlan } from "../work/task-direction.js"
import { refreshChangeEvidence } from "./change-evidence.js"
import type { ToolResult } from "@arden-hq/loop"
import { DateTime, Effect } from "effect"
import type { CommittedEventBatch } from "../events/model.js"
import { JsonObjectSchema } from "../json.js"
import {
  ToolExecutionStore,
  ToolExecutionStoreError,
  type MutationBlocker,
  type ToolExecutionBeginResult,
  type ToolExecutionIdentity
} from "../tools/store.js"
import { decodeJson, encodeJson } from "./json.js"
import {
  approvedFollowUpOf,
  beginLineage,
  detachedLineage,
  lineageColumns,
  recordAgentCall
} from "./call-lineage.js"
import type { PersistenceDeps } from "./deps.js"
import {
  type ChatRunRow,
  toolError,
  preserveToolError,
  decodeIdentity,
  loadRow,
  validateRowIdentity,
  decodeStoredResult,
  requireRow
} from "./tool-rows.js"
import {
  ensurePendingToolApprovalInTransaction,
  approvalInput,
  setRunPending,
  appendApprovalDraft,
  appendEscalatedApprovalDraft,
  resumeApprovedTool
} from "./tool-approvals.js"
import { settleUncertainRow } from "./tool-uncertainty.js"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import { unresolvedToolStatusList } from "./status-sets.js"
import {
  MAX_CALL_TARGETS,
  type EffectTarget,
  type EffectTargetOrigin
} from "../../execution/tool-effect.js"
import { storeEffectTarget } from "./effect-targets.js"
import { makeToolExecutionSettlement } from "./tool-execution-settlement.js"

export const makeToolExecutions = ({
  writer,
  chatEvents,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents">): Pick<
  ToolExecutionStore["Service"],
  | "begin"
  | "admitPlanned"
  | "complete"
  | "pause"
  | "uncertain"
  | "requireOutcomeDecision"
  | "recover"
  | "runningCount"
  | "target"
> => {
  const sql = writer.sql
  const notAdmitted = Effect.fn("SqliteToolExecutionStore.notAdmitted")(function* (
    identity: ToolExecutionIdentity
  ) {
    const run = yield* readRunAuthority(sql, identity.runId).pipe(
      Effect.mapError((cause) => toolError("begin", "storage", cause.message, identity, cause))
    )
    if (run === undefined)
      return yield* toolError("begin", "not_found", "Owning chat run was not found", identity)
    if (run.budget_missing === 1)
      return yield* toolError("begin", "corrupt", "This Run's token budget is missing", identity)
    return run.authority === "active"
      ? undefined
      : ({ _tag: "NotAdmitted", authority: run.authority } as const)
  })
  const begin = Effect.fn("SqliteToolExecutionStore.begin")(function* (
    input: ToolExecutionIdentity,
    options: {
      readonly backgrounded?: ReadonlySet<string>
      readonly plan?: ToolCallPlan
    } = {}
  ): Effect.fn.Return<ToolExecutionBeginResult, ToolExecutionStoreError> {
    const identity = yield* decodeIdentity(input, "begin")
    const argumentsJson = yield* encodeJson(JsonObjectSchema, identity.arguments).pipe(
      Effect.mapError((cause) =>
        toolError("begin", "invalid", "Tool arguments must be JSON-safe", identity, cause)
      )
    )
    const shownJson =
      options.plan?.kind !== "turn" || options.plan.shown === undefined
        ? null
        : yield* encodeJson(TaskDirectionReceiptSchema, options.plan.shown).pipe(
            Effect.mapError((cause) =>
              toolError(
                "begin",
                "invalid",
                "The call's planned direction is invalid",
                identity,
                cause
              )
            )
          )
    const planned =
      options.plan?.kind === "call"
        ? sql`(SELECT planned_from_json FROM tool_calls
            WHERE run_id = ${identity.runId} AND tool_call_id = ${options.plan.toolCallId})`
        : sql`${shownJson}`
    return yield* writer
      .transactInteractive(
        Effect.gen(function* () {
          const runs = yield* sql<ChatRunRow>`
        SELECT status FROM chat_runs
        WHERE run_id = ${identity.runId} AND session_id = ${identity.sessionId}
        LIMIT 1
      `.pipe(
            Effect.mapError((cause) =>
              toolError("begin", "storage", "Could not read the owning chat run", identity, cause)
            )
          )
          const run = runs[0]
          if (run === undefined) {
            return yield* toolError("begin", "not_found", "Owning chat run was not found", identity)
          }
          const lineage = yield* beginLineage(sql, identity, options.plan)
          if (!isActiveRunStatus(run.status)) {
            const detached = yield* detachedLineage(sql, identity, lineage)
            const deferredCallId = approvedFollowUpOf(lineage)
            const approvedRows =
              deferredCallId === undefined
                ? []
                : yield* sql<{ readonly present: number }>`
              SELECT 1 AS present FROM deferred_tool_calls
              WHERE run_id = ${identity.runId} AND session_id = ${identity.sessionId}
                AND tool_call_id = ${deferredCallId} AND tool_name = ${identity.toolName}
                AND status = 'approved'
              LIMIT 1
            `.pipe(
                    Effect.mapError((cause) =>
                      toolError(
                        "begin",
                        "storage",
                        "Could not verify the approved deferred call",
                        identity,
                        cause
                      )
                    )
                  )
            if (detached.size === 0 && approvedRows.length === 0) {
              return yield* toolError(
                "begin",
                "conflict",
                "Owning chat run is not active",
                identity
              )
            }
          }

          const existing = yield* loadRow(sql, identity, "begin")
          if (existing !== null) {
            const status = yield* validateRowIdentity(existing, identity, "begin")
            if (status === "ready") {
              const refused = yield* notAdmitted(identity)
              if (refused !== undefined) return refused
              const approval = yield* resumeApprovedTool(sql, identity)
              return {
                _tag: "Started",
                ...(approval === undefined ? {} : { approval })
              } as const
            }
            if (status === "completed" || status === "uncertain") {
              const stored = yield* decodeStoredResult(existing, identity, "begin")
              const result = yield* refreshChangeEvidence(sql, identity, stored).pipe(
                Effect.mapError((cause) =>
                  toolError(
                    "begin",
                    "storage",
                    "Could not refresh mutation evidence",
                    identity,
                    cause
                  )
                )
              )
              return {
                _tag: "Recovered",
                outcome: {
                  status,
                  result
                }
              } as const
            }
            return yield* toolError(
              "begin",
              "conflict",
              "Tool execution is already in progress",
              identity
            )
          }

          const refused = yield* notAdmitted(identity)
          if (refused !== undefined) return refused

          if (identity.changesState) {
            const unresolved = yield* sql<{
              readonly tool_call_id: string
              readonly status: string
            }>`
          SELECT tool_call_id, status
          FROM tool_calls
          WHERE run_id = ${identity.runId}
            AND changes_state = 1
            AND status IN ${unresolvedToolStatusList}
        `.pipe(
              Effect.mapError((cause) =>
                toolError(
                  "begin",
                  "storage",
                  "Could not check unresolved state-changing tool executions",
                  identity,
                  cause
                )
              )
            )
            const backgrounded = options.backgrounded ?? new Set<string>()
            const blocking = unresolved.filter(
              (row) => row.status !== "running" || !backgrounded.has(row.tool_call_id)
            )
            if (blocking.length > 0) {
              return yield* toolError(
                "begin",
                "blocked",
                "A state-changing tool outcome is uncertain",
                identity
              )
            }
          }

          const startedAt = DateTime.formatIso(yield* DateTime.now)
          const [parentCall, nesting, script] = lineageColumns(lineage)
          yield* sql`
        INSERT INTO tool_calls (
          run_id, session_id, tool_call_id, tool_name, arguments_json,
          changes_state, effect, status, result_json, started_at, ended_at, planned_from_json, parent_tool_call_id, nesting, script_tool_call_id
        ) VALUES (
          ${identity.runId}, ${identity.sessionId}, ${identity.toolCallId},
          ${identity.toolName}, ${argumentsJson}, ${Number(identity.changesState)},
          ${identity.effect ?? null}, 'running', NULL, ${startedAt}, NULL, ${planned}, ${parentCall}, ${nesting}, ${script}
        )
      `.pipe(
            Effect.andThen(recordAgentCall(sql, identity, lineage)),
            Effect.mapError((cause) =>
              toolError("begin", "storage", "Could not start tool execution", identity, cause)
            )
          )
          return { _tag: "Started" } as const
        })
      )
      .pipe(Effect.mapError(preserveToolError("begin", identity)))
  })

  const { admitPlanned, complete, pause, recover } = makeToolExecutionSettlement({
    writer,
    chatEvents,
    sessionEvents
  })
  const uncertain = Effect.fn("SqliteToolExecutionStore.uncertain")(function* (
    input: ToolExecutionIdentity
  ): Effect.fn.Return<ToolResult, ToolExecutionStoreError> {
    const identity = yield* decodeIdentity(input, "uncertain")
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const current = yield* requireRow(sql, identity, "uncertain")
          const outcome = yield* settleUncertainRow(sql, identity, "uncertain", current)
          let committed: CommittedEventBatch | null = null
          if (identity.changesState && outcome.status === "uncertain") {
            const runs = yield* sql<ChatRunRow>`
            SELECT status FROM chat_runs
            WHERE run_id = ${identity.runId} AND session_id = ${identity.sessionId}
            LIMIT 1
          `.pipe(
              Effect.mapError((cause) =>
                toolError(
                  "uncertain",
                  "storage",
                  "Could not read the owning chat run",
                  identity,
                  cause
                )
              )
            )
            const run = runs[0]
            if (run === undefined) {
              return yield* toolError(
                "uncertain",
                "not_found",
                "Owning chat run was not found",
                identity
              )
            }
            if (isActiveRunStatus(run.status)) {
              const timestamp = DateTime.formatIso(yield* DateTime.now)
              const detail =
                "This state-changing tool may have completed before the interruption. Confirm whether it completed; Arden will not run it again automatically."
              const draft = yield* ensurePendingToolApprovalInTransaction(
                sql,
                sessionEvents,
                approvalInput(identity, "tool_outcome", "verify_outcome", detail, detail),
                timestamp,
                "uncertain"
              )
              yield* setRunPending(sql, identity, timestamp, "uncertain")
              committed = yield* appendApprovalDraft(
                sql,
                chatEvents,
                identity.sessionId,
                identity,
                "uncertain",
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
              }
            }
          }
          if (committed !== null) {
            yield* sessionEvents.appendInTransaction("session_activity", identity.sessionId)
          }
          return outcome.result
        })
      )
      .pipe(Effect.mapError(preserveToolError("uncertain", identity)))
  })

  const requireOutcomeDecision = Effect.fn("SqliteToolExecutionStore.requireOutcomeDecision")(
    function* (
      input: Pick<ToolExecutionIdentity, "runId" | "sessionId">
    ): Effect.fn.Return<MutationBlocker, ToolExecutionStoreError> {
      const rows = yield* sql<{
        readonly tool_call_id: string
        readonly tool_name: string
        readonly arguments_json: string
      }>`
        SELECT tool_call_id, tool_name, arguments_json
        FROM tool_calls
        WHERE run_id = ${input.runId} AND session_id = ${input.sessionId}
          AND changes_state = 1 AND status = 'uncertain'
        ORDER BY started_at, tool_call_id
        LIMIT 1
      `.pipe(
        Effect.mapError((cause) =>
          toolError(
            "require_outcome_decision",
            "storage",
            "Could not find the uncertain tool outcome",
            undefined,
            cause
          )
        )
      )
      const blocker = rows[0]
      if (blocker === undefined) {
        const waiting = yield* sql<{ readonly tool_call_id: string }>`
          SELECT tool_call_id FROM tool_calls
          WHERE run_id = ${input.runId} AND session_id = ${input.sessionId}
            AND changes_state = 1 AND status = 'paused'
          LIMIT 1
        `.pipe(
          Effect.mapError((cause) =>
            toolError(
              "require_outcome_decision",
              "storage",
              "Could not find the blocking tool execution",
              undefined,
              cause
            )
          )
        )
        return waiting.length > 0 ? "awaiting_approval" : "stalled"
      }
      const args = yield* decodeJson(JsonObjectSchema, blocker.arguments_json).pipe(
        Effect.mapError((cause) =>
          toolError(
            "require_outcome_decision",
            "corrupt",
            "Uncertain tool arguments are invalid",
            undefined,
            cause
          )
        )
      )
      yield* uncertain({
        runId: input.runId,
        sessionId: input.sessionId,
        toolCallId: blocker.tool_call_id,
        toolName: blocker.tool_name,
        arguments: args,
        changesState: true
      })
      return "decision_required"
    }
  )

  const runningCount = Effect.fn("SqliteToolExecutionStore.runningCount")(function* (
    runIds: ReadonlyArray<string>
  ): Effect.fn.Return<number, ToolExecutionStoreError> {
    if (runIds.length === 0) return 0
    const rows = yield* sql<{ readonly count: number }>`
      SELECT count(*) AS count FROM tool_calls
      WHERE status = 'running' AND run_id IN ${sql.in(runIds)}
    `.pipe(
      Effect.mapError((cause) =>
        toolError("recover", "storage", "Could not count running tool executions", undefined, cause)
      )
    )
    return rows[0]?.count ?? 0
  })

  const target = Effect.fn("SqliteToolExecutionStore.target")(function* (input: {
    readonly runId: string
    readonly toolCallId: string
    readonly target: EffectTarget
    readonly origin: EffectTargetOrigin
  }): Effect.fn.Return<void, ToolExecutionStoreError> {
    const at = DateTime.formatIso(yield* DateTime.now)
    const stored = yield* writer
      .transactInteractive(storeEffectTarget(sql, input, at))
      .pipe(Effect.mapError(preserveToolError("target", input)))
    if (stored === "not_running")
      return yield* toolError("target", "conflict", "The call is no longer running", input)
    if (stored === "too_many")
      return yield* toolError(
        "target",
        "conflict",
        `A call names at most ${MAX_CALL_TARGETS} objects`,
        input
      )
  })

  return {
    begin,
    admitPlanned,
    complete,
    pause,
    uncertain,
    target,
    requireOutcomeDecision,
    recover,
    runningCount
  }
}
