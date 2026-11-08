import { executionBudgetExpired } from "./execution-budgets.js"
import { DateTime, Effect, Schema } from "effect"
import { readHeadSequence } from "@arden-hq/journal/effect"
import type { ChatWriteStore, ChatWriteResume, ChatWriteFailure } from "../chat/store.js"
import type { IntelligenceSettingsStore } from "../settings/store.js"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import {
  runAutomationContextMode,
  runOutputSchema,
  runAutomationOrigin,
  loadRun,
  requireReceiptForRun,
  setCheckpoint
} from "./chat-run.js"
import { loadSession, schedulingForSession } from "./chat-session.js"
import { completedRunReply } from "./run-completion.js"
import { scriptOwnsRun } from "./run-owner.js"
import { awaitingApproval, quotaPaused } from "./run-wait.js"
import { loadActiveMessages, loadMintedMessageIds } from "./chat-transcript.js"
import { mapFailure, validateInput, writeError } from "./chat-write-errors.js"
import { interruptStrandedChatRuns } from "./recovery.js"
import { loadRunStreamedMessages } from "./recovery-finish.js"
import { staleStreamedIds } from "../transcript/minted-ids.js"
import type { PersistenceDeps } from "./deps.js"
import { noApprovalForRun } from "./approval-policy.js"

export const makeChatRecovery = ({
  writer,
  chatEvents,
  sessionEvents,
  intelligence
}: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents"> & {
  readonly intelligence: IntelligenceSettingsStore["Service"]
}): Pick<
  ChatWriteStore["Service"],
  "interruptStranded" | "sideRunsAwaitingApproval" | "listResumable" | "claimResume"
> => {
  const sql = writer.sql
  const interruptStranded = Effect.fn("SqliteChatWriteStore.interruptStranded")(function* (input: {
    readonly ownedRunIds: ReadonlyArray<string>
  }): Effect.fn.Return<ReadonlyArray<string>, ChatWriteFailure> {
    return yield* interruptStrandedChatRuns({
      writer,
      chatEvents,
      sessionEvents,
      ownedRunIds: input.ownedRunIds
    }).pipe(Effect.mapError(mapFailure("interrupt_stranded")))
  })

  const sideRunsAwaitingApproval = Effect.fn("SqliteChatWriteStore.sideRunsAwaitingApproval")(
    function* (): Effect.fn.Return<ReadonlyArray<string>, ChatWriteFailure> {
      const rows = yield* sql<{ readonly run_id: string }>`SELECT DISTINCT run.run_id
        FROM chat_runs run JOIN tool_approvals approval ON approval.run_id = run.run_id
        WHERE run.status = 'pending' AND approval.status = 'pending'
          AND approval.kind = 'tool_approval'
        ORDER BY run.run_id`.pipe(
        Effect.mapError((cause) =>
          writeError("interrupt_stranded", "storage", "Could not list older Side chat approvals", {
            cause
          })
        )
      )
      const scoped = yield* Effect.forEach(rows, (row) =>
        noApprovalForRun(sql, row.run_id).pipe(
          Effect.map((noApproval) => (noApproval ? row.run_id : undefined)),
          Effect.mapError((cause) =>
            writeError("interrupt_stranded", "storage", "Could not inspect Side chat approval", {
              runId: row.run_id,
              cause
            })
          )
        )
      )
      return scoped.filter((runId): runId is string => runId !== undefined)
    }
  )

  const listResumable = Effect.fn("SqliteChatWriteStore.listResumable")(
    function* (): Effect.fn.Return<ReadonlyArray<string>, ChatWriteFailure> {
      const now = DateTime.formatIso(yield* DateTime.now)
      const rows = yield* sql<{ readonly run_id: string }>`
      SELECT run.run_id
      FROM chat_runs AS run
      WHERE run.status = 'pending'
        AND NOT ${quotaPaused(sql, sql`run.metadata_json`, now)}
        AND NOT ${awaitingApproval(sql, sql`run.run_id`)}
      ORDER BY run.updated_at, run.started_at, run.run_id
    `.pipe(
        Effect.mapError((cause) =>
          writeError("list_resumable", "storage", "Could not list resumable Chat runs", { cause })
        )
      )
      return rows.map((row) => row.run_id)
    }
  )

  const claimResume = Effect.fn("SqliteChatWriteStore.claimResume")(function* (
    runIdInput: string
  ): Effect.fn.Return<ChatWriteResume | null, ChatWriteFailure> {
    const runId = yield* validateInput(Schema.NonEmptyString, runIdInput, "claim_resume")
    const controls = yield* intelligence
      .settings()
      .pipe(
        Effect.mapError((cause) =>
          writeError("claim_resume", "storage", "Could not read agent settings", { runId, cause })
        )
      )
    const timestamp = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const run = yield* loadRun(sql, runId, "claim_resume")
          if (run.status !== "pending") return null
          const automation = yield* runAutomationOrigin(run, "claim_resume")
          const automationContextMode = yield* runAutomationContextMode(run, "claim_resume")
          const outputSchema = yield* runOutputSchema(run, "claim_resume")
          const unresolved = yield* sql<{ readonly present: number }>`
        SELECT ${awaitingApproval(sql, sql`${run.run_id}`)} AS present
      `.pipe(
            Effect.mapError((cause) =>
              writeError("claim_resume", "storage", "Could not inspect pending tool decisions", {
                runId: run.run_id,
                sessionId: run.session_id,
                cause
              })
            )
          )
          if (unresolved[0]?.present === 1) return null
          yield* requireReceiptForRun(sql, run, "claim_resume")
          const session = yield* loadSession(sql, run.session_id, "claim_resume")
          const scheduling = yield* schedulingForSession(
            sql,
            session.session_id,
            session.session_type,
            controls.maxConcurrentAgents,
            "claim_resume"
          )
          const activeMessages = yield* loadActiveMessages(sql, run.session_id, "claim_resume")
          if (yield* scriptOwnsRun(sql, run.run_id)) return null
          if ((yield* completedRunReply(sql, run.run_id, activeMessages)) !== undefined) {
            return yield* writeError(
              "claim_resume",
              "corrupt",
              "Resumable Chat run already holds its final assistant message",
              { runId: run.run_id, sessionId: run.session_id }
            )
          }

          const claimed = yield* sql<{ readonly run_id: string }>`
        UPDATE chat_runs
        SET status = 'running', stop_reason = NULL, updated_at = ${timestamp},
            ended_at = NULL, error_code = NULL, error_message = NULL,
            metadata_json = json_remove(metadata_json, '$.quota_pause')
        WHERE run_id = ${run.run_id} AND status = 'pending'
          AND NOT ${executionBudgetExpired(sql, sql`metadata_json`)}
          AND NOT ${quotaPaused(sql, sql`metadata_json`, timestamp)}
        RETURNING run_id
      `.pipe(
            Effect.mapError((cause) =>
              writeError("claim_resume", "storage", "Could not claim paused Chat run", {
                runId: run.run_id,
                sessionId: run.session_id,
                cause
              })
            )
          )
          if (claimed.length !== 1) return null
          yield* sql`
        UPDATE chat_idempotency_keys
        SET status = 'running', updated_at = ${timestamp}
        WHERE run_id = ${run.run_id} AND client_id = ${run.client_id}
      `
          yield* sql`
        UPDATE sessions
        SET last_activity = ${timestamp}
        WHERE session_id = ${run.session_id}
      `
          const resumed = yield* chatEvents.appendInTransaction({
            sessionId: run.session_id,
            events: [
              {
                runId: run.run_id,
                event: {
                  type: "thinking",
                  run_id: run.run_id,
                  session_id: run.session_id,
                  status: "Continuing saved work"
                }
              }
            ]
          })
          yield* setCheckpoint(
            sql,
            chatEvents,
            run.session_id,
            run.run_id,
            resumed.headSequence,
            "claim_resume"
          )
          const mintedMessageIds = yield* loadMintedMessageIds(
            sql,
            run.session_id,
            run.assistant_message_id,
            "claim_resume"
          )
          const assistantMessagePersisted = mintedMessageIds.includes(run.assistant_message_id)
          const { started } = yield* loadRunStreamedMessages(sql, run.session_id, run.run_id).pipe(
            Effect.mapError((cause) =>
              writeError("claim_resume", "storage", "Could not load the run's streamed messages", {
                runId: run.run_id,
                sessionId: run.session_id,
                cause
              })
            )
          )
          const staleIds = [
            ...new Set([
              ...(assistantMessagePersisted ? [] : [run.assistant_message_id]),
              ...staleStreamedIds(run.assistant_message_id, new Set(mintedMessageIds), started)
            ])
          ]
          const reset =
            staleIds.length === 0
              ? null
              : yield* chatEvents
                  .appendInTransaction({
                    sessionId: run.session_id,
                    events: [
                      {
                        event: {
                          type: "model_response_reset",
                          message_ids: staleIds,
                          tool_call_ids: []
                        } satisfies ChatProjectionEvent,
                        runId: run.run_id
                      }
                    ]
                  })
                  .pipe(
                    Effect.mapError((cause) =>
                      writeError(
                        "claim_resume",
                        "storage",
                        "Could not reset the resumed assistant message",
                        { runId: run.run_id, sessionId: run.session_id, cause }
                      )
                    )
                  )
          if (reset !== null) {
            yield* setCheckpoint(
              sql,
              chatEvents,
              run.session_id,
              run.run_id,
              reset.headSequence,
              "claim_resume"
            )
          }
          const head = yield* readHeadSequence(sql, run.session_id).pipe(
            Effect.mapError((cause) =>
              writeError("claim_resume", "storage", "Could not load Chat event head", {
                runId: run.run_id,
                sessionId: run.session_id,
                cause
              })
            )
          )
          yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
          return {
            runId: run.run_id,
            sessionId: run.session_id,
            assistantMessageId: run.assistant_message_id,
            mintedMessageIds,
            model: run.model_id,
            reasoningEffort: run.reasoning_effort,
            approvalMode: run.approval_mode,
            outputSchema,
            automation,
            automationContextMode,
            turnId: run.turn_id,
            activeMessages,
            eventSequence: head ?? run.last_seq ?? 0,
            scheduling
          } satisfies ChatWriteResume
        })
      )
      .pipe(Effect.mapError(mapFailure("claim_resume", { runId })))
  })

  return { interruptStranded, sideRunsAwaitingApproval, listResumable, claimResume }
}
