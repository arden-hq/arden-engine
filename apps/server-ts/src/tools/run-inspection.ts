import { ToolExecutionError } from "@arden-hq/loop"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import { DateTime, Effect, Schema } from "effect"
import type { RunQueries } from "../persistence/runs/queries.js"
import { parentCompletion } from "../persistence/runs/parent-completion.js"
import type { SessionQueries } from "../persistence/sessions/queries.js"
import { currentIso } from "../runtime/clock.js"
import { defineServerTool, type ServerTool } from "./define.js"

const ReferenceSchema = Schema.NonEmptyString.check(Schema.isMaxLength(200))

export const runInspectTool = (services: {
  readonly runs: RunQueries["Service"]
  readonly sessions: SessionQueries["Service"]
}): ServerTool =>
  defineServerTool({
    name: "run_inspect",
    description:
      "Inspect current work by exact session_ref, or one stable Run by run_id. Choose exactly one. Returns observed progress, active approvals and pending input, the decided ending and a bounded worker report. A completed run or no_change report does not prove the assignment or external actions succeeded. Use the returned session_read actions reference for deeper evidence; missing receipts or removed traces limit diagnosis. Child inspection never acknowledges completion delivery.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        run_id: Schema.optionalKey(
          ReferenceSchema.annotate({
            description: "Exact run_id from recorded run evidence or Agent family."
          })
        ),
        session_ref: Schema.optionalKey(
          ReferenceSchema.annotate({
            description:
              "Exact session_ref from Agent family, spawn_agent or session_list. Selects the active run first, otherwise the newest admitted run."
          })
        )
      }).check(
        Schema.makeFilter((input) =>
          (input.run_id === undefined) !== (input.session_ref === undefined)
            ? undefined
            : "Choose exactly one of run_id or session_ref"
        )
      )
    ),
    metadata: {
      effect: "none",
      kind: "tool",
      action: "read",
      source: "_system",
      changes_state: false,
      concurrency_group: null,
      destructive: false,
      display_name: "Inspect Run",
      approval_preview: "Read recorded work and current progress."
    },
    execute: async (input, ctx) => {
      const execute = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.runPromise(effect, { signal: ctx.signal })
      const resolveSessionId = async () => {
        if (input.run_id !== undefined) return execute(services.runs.sessionId(input.run_id))
        if (input.session_ref !== undefined)
          return (await execute(services.sessions.sessionIdForRef(input.session_ref))) ?? undefined
        throw new ToolExecutionError("Choose exactly one of run_id or session_ref", {
          retryable: false
        })
      }
      const sessionId = await resolveSessionId()
      if (sessionId === undefined)
        throw new ToolExecutionError("Run or chat no longer exists", { retryable: false })
      const [requester, owner] = await Promise.all([
        execute(services.sessions.loadHistoryHeader(ctx.run.sessionId)),
        execute(services.sessions.loadHistoryHeader(sessionId))
      ])
      if (
        requester === null ||
        owner === null ||
        (requester.spaceId !== null && requester.spaceId !== owner.spaceId)
      )
        throw new ToolExecutionError("Run is not visible from this chat", { retryable: false })
      const reference =
        input.session_ref === undefined
          ? undefined
          : (await execute(services.runs.currentForSessions([sessionId]))).get(sessionId)
      const selectedRunId = input.run_id ?? reference?.current.runId
      const run =
        selectedRunId === undefined ? undefined : await execute(services.runs.get(selectedRunId))
      if (run === undefined || run === null)
        throw new ToolExecutionError("No retained run for this chat", { retryable: false })
      const [progress, active, ending] = await Promise.all([
        execute(services.runs.progress(run.runId)),
        execute(services.runs.active(run.runId)),
        execute(services.runs.ending(run.runId))
      ])
      const report =
        owner.sessionType !== "agent" ||
        owner.parentSessionId === null ||
        (ending === undefined && isActiveRunStatus(run.status))
          ? undefined
          : parentCompletion({
              runId: run.runId,
              sessionRef: owner.publicRef,
              status: run.status,
              stopReason: run.stopReason,
              ending,
              noChangeReason:
                typeof run.metadata.no_change_reason === "string"
                  ? run.metadata.no_change_reason
                  : undefined
            })
      const latest = reference?.latestEnding ?? ending
      return {
        result: JSON.stringify({
          observed_at: currentIso(),
          session_ref: owner.publicRef,
          run_id: run.runId,
          session_id: run.sessionId,
          status: run.status,
          stop_reason: run.stopReason,
          error_code: run.errorCode,
          error_message: run.errorMessage,
          started_at: DateTime.formatIso(run.startedAt),
          updated_at: DateTime.formatIso(run.updatedAt),
          model: run.modelId,
          usage: run.metadata.accounted_usage ?? null,
          local_instructions: run.metadata.local_instructions ?? null,
          progress,
          activity:
            active === undefined
              ? { state: "not_active" }
              : {
                  state: "active",
                  pending_inputs: active.pendingInjections,
                  approvals_pending: active.approvalsPending,
                  message_count: active.messageCount,
                  updated_at: DateTime.formatIso(active.updatedAt)
                },
          ending:
            ending === undefined
              ? null
              : {
                  run_id: ending.runId,
                  status: ending.status,
                  detail: ending.detail,
                  occurred_at: ending.occurredAt
                },
          report:
            report === undefined
              ? null
              : { outcome: report.outcome, state: report.reportState, text: report.text },
          latest_decided_ending:
            latest === undefined
              ? null
              : {
                  run_id: latest.runId,
                  status: latest.status,
                  detail: latest.detail,
                  occurred_at: latest.occurredAt
                },
          evidence: {
            tool: "session_read",
            arguments: { session_ref: owner.publicRef, view: "actions", action_turn_id: run.turnId }
          }
        }),
        preview: run.status
      }
    }
  })
