import { ACTIVE_RUN_STATUSES } from "@arden-hq/protocol/runs"
import { disposableForkSql } from "../schema/fork-disposition.js"
import { DateTime, Effect } from "effect"
import { SqlClient, type Statement } from "effect/unstable/sql"
import { ChatEventStore } from "../events/store.js"
import { SessionLifecycleEvents } from "../sessions/events.js"
import type { UnitOfWork } from "../unit-of-work.js"
import { runCancellationRequested } from "./run-cancellation.js"
import { executionBudgetExpired } from "./execution-budgets.js"
import { reconcileEndings } from "./run-ending.js"
import { settleRun } from "./run-settle.js"
import { markRunToolExecutionsUncertainInTransaction } from "./tool-uncertainty.js"
import { settleUnstartedToolWorkForTerminalInTransaction } from "./tool-receipts.js"
import type { PersistenceDeps } from "./deps.js"
import { type ActiveChatRunRow, durableFinalReply, type RecoveryCause } from "./recovery-finish.js"
import {
  activeRunStatusList,
  statusSqlList,
  UNRESOLVED_TOOL_STATUSES,
  modelTurnRunStatusList,
  terminalRunStatusList,
  unfinishedRequestStatusList
} from "./status-sets.js"
import { appendRunSettledInTransaction } from "./run-settled.js"
import { decisionLineageSql } from "../schema/decision-visibility.js"
import {
  lastActiveAt,
  lostOwner,
  recoverChatRunInTransaction,
  recoveryError,
  serverRestart
} from "./recovery-run.js"

const unrecoverable =
  "The assistant run was interrupted, and its unfinished steps could not be restored."

const quarantineChatRunInTransaction = Effect.fn("SqlitePersistence.quarantineChatRun")(function* (
  sql: SqlClient.SqlClient,
  chatEvents: ChatEventStore["Service"],
  sessionEvents: SessionLifecycleEvents["Service"],
  run: ActiveChatRunRow,
  timestamp: string,
  cause: RecoveryCause
) {
  const lastActive = yield* lastActiveAt(sql, run.run_id, timestamp)
  yield* markRunToolExecutionsUncertainInTransaction(sql, run.run_id, timestamp, cause.ending)
  yield* settleUnstartedToolWorkForTerminalInTransaction(sql, run.run_id, timestamp, "failed")
  const turnId = run.turn_id === null || run.turn_id.length === 0 ? undefined : run.turn_id
  const committed =
    turnId === undefined
      ? undefined
      : yield* chatEvents.appendInTransaction({
          sessionId: run.session_id,
          events: [
            {
              event: {
                type: "RUN_ERROR",
                run_id: run.run_id,
                session_id: run.session_id,
                turn_id: turnId,
                code: "run_interrupted",
                message: unrecoverable
              },
              runId: run.run_id
            }
          ]
        })
  yield* sql`
    UPDATE chat_runs
    SET status = 'interrupted',
        stop_reason = 'recovery_failed',
        error_code = 'run_interrupted',
        error_message = ${unrecoverable},
        updated_at = ${timestamp},
        ended_at = ${timestamp},
        last_seq = COALESCE(${committed?.headSequence ?? null}, last_seq)
    WHERE run_id = ${run.run_id}
  `
  yield* sql`
    UPDATE chat_idempotency_keys
    SET status = 'interrupted', updated_at = ${timestamp}
    WHERE run_id = ${run.run_id}
      AND status IN ${unfinishedRequestStatusList}
  `
  if (committed !== undefined) {
    yield* chatEvents.setCheckpointInTransaction(run.session_id, committed.headSequence)
  }
  const reply = yield* durableFinalReply(sql, run.run_id)
  yield* settleRun(
    { sql, sessionEvents, chatEvents },
    {
      runId: run.run_id,
      now: timestamp,
      occurredAt: lastActive,
      terminal: {
        status: "failed",
        error:
          reply === undefined
            ? unrecoverable
            : `${unrecoverable}\n\nIts final reply before it stopped:\n\n${reply}`
      }
    }
  )
  yield* sql`
    UPDATE sessions
    SET last_activity = ${timestamp}
    WHERE session_id = ${run.session_id}
  `
  yield* appendRunSettledInTransaction(sql, sessionEvents, run.run_id)
  yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
})

interface RecoveryCandidate extends ActiveChatRunRow {
  readonly started_at: string
}

const RECOVERY_PAGE_SIZE = 100

const recoverEachChatRun = Effect.fn("SqlitePersistence.recoverEachChatRun")(function* (
  {
    writer,
    chatEvents,
    sessionEvents
  }: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents">,
  select: (
    where: Statement.Fragment
  ) => Effect.Effect<ReadonlyArray<RecoveryCandidate>, unknown, UnitOfWork>,
  cause: RecoveryCause
) {
  const sql = writer.sql
  const settled: Array<string> = []
  let after: RecoveryCandidate | undefined
  while (true) {
    const where =
      after === undefined
        ? sql`1`
        : sql`
      (run.session_id, run.started_at, run.run_id) > (${after.session_id}, ${after.started_at}, ${after.run_id})`
    const runs = yield* writer.transact(select(where)).pipe(Effect.mapError(recoveryError))
    if (runs.length === 0) break
    for (const candidate of runs) {
      const recover = writer.transact(
        Effect.gen(function* () {
          const [run] = yield* select(sql`run.run_id = ${candidate.run_id}`)
          if (run === undefined) return { settled: false }
          const timestamp = DateTime.formatIso(yield* DateTime.now)
          return yield* recoverChatRunInTransaction(
            sql,
            chatEvents,
            sessionEvents,
            run,
            timestamp,
            cause
          )
        })
      )
      const recovered = yield* recover.pipe(
        Effect.catch((failure) =>
          Effect.logError("Chat run recovery failed; quarantining the run").pipe(
            Effect.annotateLogs({
              runId: candidate.run_id,
              sessionId: candidate.session_id,
              failure
            }),
            Effect.andThen(
              writer.transact(
                Effect.gen(function* () {
                  const [run] = yield* select(sql`run.run_id = ${candidate.run_id}`)
                  if (run === undefined) return { settled: false }
                  const timestamp = DateTime.formatIso(yield* DateTime.now)
                  yield* quarantineChatRunInTransaction(
                    sql,
                    chatEvents,
                    sessionEvents,
                    run,
                    timestamp,
                    cause
                  )
                  return { settled: true }
                })
              )
            ),
            Effect.catch((quarantineFailure) =>
              Effect.logError("Chat run quarantine failed; the run stays open").pipe(
                Effect.annotateLogs({
                  runId: candidate.run_id,
                  sessionId: candidate.session_id,
                  failure: quarantineFailure
                }),
                Effect.as({ settled: false })
              )
            )
          )
        )
      )
      if (recovered.settled) settled.push(candidate.run_id)
    }
    after = runs[runs.length - 1]
  }
  return settled
})

const ENDED_RUNS_WITH_RUNNING_CALLS_SQL = `SELECT run.run_id FROM chat_runs AS run
  WHERE run.run_id IN (
      SELECT call.run_id FROM tool_calls AS call
      WHERE call.status IN ${statusSqlList(UNRESOLVED_TOOL_STATUSES)} AND call.status = 'running')
    AND run.status NOT IN ${statusSqlList(ACTIVE_RUN_STATUSES)}`

export const interruptActiveChatRunsAfterRestart = Effect.fn(
  "SqlitePersistence.interruptActiveChatRunsAfterRestart"
)(function* (deps: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents">) {
  const sql = deps.writer.sql
  yield* deps.writer
    .transact(
      Effect.gen(function* () {
        const stale = yield* sql<{
          readonly run_id: string
          readonly session_id: string
          readonly tool_call_id: string
        }>`SELECT approval.run_id, approval.session_id, approval.tool_call_id
          FROM tool_approvals AS approval
          JOIN chat_runs AS run ON run.run_id = approval.run_id
          WHERE approval.kind = 'tool_outcome' AND approval.status = 'pending'
            AND run.status IN ${terminalRunStatusList}`
        for (const source of stale) {
          const lineage = yield* sql.unsafe<{
            readonly session_id: string
            readonly session_type: string
            readonly edge_valid: number
          }>(decisionLineageSql("?"), [source.session_id])
          const valid =
            lineage.length > 0 &&
            lineage.every((row) => row.edge_valid === 1) &&
            lineage.some((row) => row.session_type !== "agent")
          const side = valid ? lineage.find((row) => row.session_type === "chat") : undefined
          if (side !== undefined) {
            const retained = yield* sql`SELECT 1 FROM session_fork_requests AS fork
              JOIN sessions AS parent ON parent.session_id = fork.source_session_id
                AND parent.session_type = 'chat'
              WHERE fork.child_session_id = ${side.session_id} AND fork.state = 'ready'
                AND json_valid(fork.request_json)
                AND ${sql.literal(disposableForkSql("fork"))}
              LIMIT 1`
            if (retained.length > 0) continue
          }
          yield* sql`DELETE FROM tool_approvals
            WHERE run_id = ${source.run_id} AND tool_call_id = ${source.tool_call_id}
              AND kind = 'tool_outcome' AND status = 'pending'`
        }
      })
    )
    .pipe(Effect.mapError(recoveryError))
  yield* recoverEachChatRun(
    deps,
    (where) =>
      sql<RecoveryCandidate>`
        SELECT run.run_id, run.session_id, run.started_at,
               json_extract(run.metadata_json, '$.turn_id') AS turn_id,
               CASE WHEN ${runCancellationRequested(sql, sql`run.metadata_json`)} OR EXISTS (
                 SELECT 1 FROM space_tasks AS task
                 WHERE task.item_id = json_extract(run.metadata_json, '$.run_context.task.item_id')
                   AND task.status = 'cancelled'
               ) THEN 1 ELSE 0 END AS cancellation_requested,
               run.assistant_message_id
        FROM chat_runs AS run
        WHERE run.status IN ${activeRunStatusList}
          AND ${where}
        ORDER BY run.session_id, run.started_at, run.run_id
        LIMIT ${RECOVERY_PAGE_SIZE}
      `,
    serverRestart
  )
  yield* deps.writer
    .transact(
      Effect.gen(function* () {
        const timestamp = DateTime.formatIso(yield* DateTime.now)
        const ended = yield* sql.unsafe<{ readonly run_id: string }>(
          ENDED_RUNS_WITH_RUNNING_CALLS_SQL
        )
        for (const { run_id } of ended)
          yield* markRunToolExecutionsUncertainInTransaction(
            sql,
            run_id,
            timestamp,
            serverRestart.ending
          )
      })
    )
    .pipe(Effect.mapError(recoveryError))
  yield* deps.writer.transact(reconcileEndings(sql)).pipe(Effect.mapError(recoveryError))
})

export const interruptStrandedChatRuns = Effect.fn("SqlitePersistence.interruptStrandedChatRuns")(
  function* ({
    ownedRunIds,
    ...deps
  }: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents"> & {
    readonly ownedRunIds: ReadonlyArray<string>
  }) {
    const sql = deps.writer.sql
    const settled = yield* recoverEachChatRun(
      deps,
      (where) =>
        sql<RecoveryCandidate>`
        SELECT run.run_id, run.session_id, run.started_at,
               json_extract(run.metadata_json, '$.turn_id') AS turn_id,
               ${runCancellationRequested(sql, sql`run.metadata_json`)} AS cancellation_requested,
               run.assistant_message_id
        FROM chat_runs AS run
        -- The first line repeats idx_chat_runs_active's own condition, so SQLite
        -- reads that short list of unfinished runs instead of every run.
        WHERE run.status IN ${activeRunStatusList} AND (
            -- Turns the lost process was running; their background work is the script's.
            run.status IN ${modelTurnRunStatusList}
            OR (run.status = 'pending' AND ${executionBudgetExpired(sql, sql`run.metadata_json`)})
          )
          AND ${where}
          AND ${ownedRunIds.length === 0 ? sql`1` : sql`run.run_id NOT IN ${sql.in(ownedRunIds)}`}
        ORDER BY run.session_id, run.started_at, run.run_id
        LIMIT ${RECOVERY_PAGE_SIZE}
      `,
      lostOwner
    )
    yield* deps.writer.transact(reconcileEndings(sql)).pipe(Effect.mapError(recoveryError))
    return settled
  }
)
