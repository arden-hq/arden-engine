import { WorkflowErrorSchema } from "@arden-hq/protocol/effect/workflows"
import type { WorkflowError } from "@arden-hq/protocol/workflows"
import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"

import {
  ScriptStore,
  ScriptStoreError,
  type ScriptRecord,
  type ScriptSettlement
} from "../scripts/store.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import type { PersistenceDeps } from "./deps.js"
import { decodeJson } from "./json.js"
import { runCancellationRequested } from "./run-cancellation.js"
import { readScriptExecutions } from "./script-executions.js"
import { insertScriptResult } from "./script-results.js"
import { settleUnstartedToolWorkForTerminalInTransaction } from "./tool-receipts.js"

interface ScriptRow {
  readonly script_ref: string
  readonly origin_session_ref: string
  readonly origin_session_id: string
  readonly origin_run_id: string
  readonly origin_tool_call_id: string
  readonly profile_hash: string
  readonly status: string
  readonly version: number
  readonly attempt: number
  readonly auto_retries: number
  readonly error_json: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly ended_at: string | null
}

const StatusSchema = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "needs_attention"
] as const)

const storeError = (
  reason: ScriptStoreError["reason"],
  message: string,
  ref?: string,
  cause?: unknown
): ScriptStoreError =>
  new ScriptStoreError({
    reason,
    message,
    ...(ref === undefined ? {} : { ref }),
    ...(cause === undefined ? {} : { cause })
  })

const storage = (message: string, ref?: string) => (cause: unknown) =>
  cause instanceof ScriptStoreError ? cause : storeError("storage", message, ref, cause)

const cancelledError: WorkflowError = {
  code: "cancelled",
  message: "The script was cancelled",
  retryable: false,
  recovery_action: null
}

const selectScripts = (sql: SqlClient.SqlClient) => sql`
  SELECT script.script_ref, script.origin_session_ref, session.session_id AS origin_session_id,
         script.origin_run_id, script.origin_tool_call_id, script.profile_hash, script.status,
         script.version, script.attempt, script.auto_retries, script.error_json,
         script.created_at, script.updated_at, script.ended_at
  FROM code_mode_scripts AS script
  JOIN sessions AS session ON session.public_ref = script.origin_session_ref`

const decodeRecord = Effect.fn("ScriptStore.decode")(function* (row: ScriptRow) {
  const corrupt = (cause: unknown) =>
    storeError("corrupt", "Stored script record is corrupt", row.script_ref, cause)
  const status = yield* Schema.decodeUnknownEffect(StatusSchema)(row.status).pipe(
    Effect.mapError(corrupt)
  )
  const error =
    row.error_json === null
      ? null
      : yield* decodeJson(WorkflowErrorSchema, row.error_json).pipe(Effect.mapError(corrupt))
  return {
    ref: row.script_ref,
    originSessionRef: row.origin_session_ref,
    originSessionId: row.origin_session_id,
    originRunId: row.origin_run_id,
    originToolCallId: row.origin_tool_call_id,
    profileHash: row.profile_hash,
    status,
    version: row.version,
    attempt: row.attempt,
    autoRetries: row.auto_retries,
    error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at
  } satisfies ScriptRecord
})

export const makeScriptStore = ({
  writer,
  sessionEvents
}: Pick<PersistenceDeps, "writer"> & {
  readonly sessionEvents: Pick<SessionLifecycleEvents["Service"], "appendBlockingWorkInTransaction">
}): ScriptStore["Service"] => {
  const sql = writer.sql

  const find = Effect.fn("ScriptStore.find")(function* (ref: string) {
    const rows = yield* sql<ScriptRow>`${selectScripts(sql)} WHERE script.script_ref = ${ref}`
    const row = rows[0]
    return row === undefined ? undefined : yield* decodeRecord(row)
  })

  const load = Effect.fn("ScriptStore.load")(function* (ref: string) {
    const record = yield* find(ref)
    if (record === undefined) return yield* storeError("not_found", "Script does not exist", ref)
    return record
  })

  const announce = (record: ScriptRecord) =>
    sessionEvents.appendBlockingWorkInTransaction(record.originSessionId)

  const create: ScriptStore["Service"]["create"] = Effect.fn("ScriptStore.create")(
    function* (input) {
      return yield* writer
        .transact(
          Effect.gen(function* () {
            const existing = yield* sql<ScriptRow>`${selectScripts(sql)}
              WHERE script.origin_run_id = ${input.originRunId}
                AND script.origin_tool_call_id = ${input.originToolCallId}`
            const prior = existing[0]
            if (prior !== undefined) {
              if (prior.script_ref !== input.ref) {
                return yield* storeError(
                  "conflict",
                  "This code_mode call already owns another script",
                  input.ref
                )
              }
              return yield* decodeRecord(prior)
            }
            const now = DateTime.formatIso(yield* DateTime.now)
            yield* sql`INSERT INTO code_mode_scripts (
                script_ref, origin_session_ref, origin_run_id, origin_tool_call_id, profile_hash,
                status, version, attempt, auto_retries, created_at, updated_at, progress_json
              ) VALUES (
                ${input.ref}, ${input.originSessionRef}, ${input.originRunId},
                ${input.originToolCallId}, ${input.profileHash}, 'running', 1, 1, 0, ${now}, ${now}, '{}'
              )`
            const record = yield* load(input.ref)
            yield* announce(record)
            return record
          })
        )
        .pipe(Effect.mapError(storage("Could not create the script", input.ref)))
    }
  )

  const get = (ref: string) =>
    load(ref).pipe(Effect.mapError(storage("Could not read the script", ref)))

  const originFenced = sql`EXISTS (SELECT 1 FROM chat_runs AS origin
    WHERE origin.run_id = script.origin_run_id
      AND ${runCancellationRequested(sql, sql`origin.metadata_json`)})`
  const runningWhere = (fenced: boolean) =>
    sql<ScriptRow>`${selectScripts(sql)}
      WHERE script.status = 'running' AND ${fenced ? originFenced : sql`NOT ${originFenced}`}
      ORDER BY script.created_at, script.script_ref`.pipe(
      Effect.mapError(storage("Could not read running scripts")),
      Effect.flatMap((rows) => Effect.forEach(rows, decodeRecord))
    )
  const running = Effect.fn("ScriptStore.running")(function* () {
    return yield* runningWhere(false)
  })
  const runningOfFencedRuns = Effect.fn("ScriptStore.runningOfFencedRuns")(function* () {
    return yield* runningWhere(true)
  })

  const nextAttempt: ScriptStore["Service"]["nextAttempt"] = (input) =>
    writer
      .transact(
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now)
          const updated = yield* sql`UPDATE code_mode_scripts
            SET attempt = attempt + 1, version = version + 1, updated_at = ${now},
                auto_retries = auto_retries + ${input.auto ? 1 : 0}
            WHERE script_ref = ${input.ref} AND status = 'running' AND attempt = ${input.attempt}
            RETURNING script_ref`
          if (updated.length === 0) {
            return yield* storeError("conflict", "The script moved on before its retry", input.ref)
          }
          return yield* load(input.ref)
        })
      )
      .pipe(Effect.mapError(storage("Could not start the script's next attempt", input.ref)))

  const retry: ScriptStore["Service"]["retry"] = (input) =>
    writer
      .transact(
        Effect.gen(function* () {
          const record = yield* load(input.ref)
          if (record.status === "running") {
            return yield* storeError("conflict", "A running script cannot be retried", input.ref)
          }
          if (record.version !== input.expectedVersion) {
            return yield* storeError("conflict", "The script changed before the retry", input.ref)
          }
          const now = DateTime.formatIso(yield* DateTime.now)
          yield* sql`UPDATE code_mode_scripts
            SET status = 'running', attempt = attempt + 1, version = version + 1,
                auto_retries = 0, error_json = NULL, updated_at = ${now}, ended_at = NULL
            WHERE script_ref = ${input.ref} AND version = ${input.expectedVersion}`
          const retried = yield* load(input.ref)
          yield* announce(retried)
          return retried
        })
      )
      .pipe(Effect.mapError(storage("Could not retry the script", input.ref)))

  const settleIn = Effect.fn("ScriptStore.settleIn")(function* (
    ref: string,
    attempt: number,
    settlement: ScriptSettlement
  ) {
    const now = DateTime.formatIso(yield* DateTime.now)
    const errorJson = settlement.error === null ? null : JSON.stringify(settlement.error)
    const updated = yield* sql`UPDATE code_mode_scripts
      SET status = ${settlement.status}, error_json = ${errorJson}, version = version + 1,
          updated_at = ${now}, ended_at = ${now}
      WHERE script_ref = ${ref} AND status = 'running' AND attempt = ${attempt}
      RETURNING script_ref`
    if (updated.length === 0) return undefined
    const record = yield* load(ref)
    yield* insertScriptResult(sql, {
      workflowRef: ref,
      attempt,
      sessionId: record.originSessionId,
      sessionRef: record.originSessionRef,
      originRunId: record.originRunId,
      status: settlement.status,
      value: settlement.value,
      error: settlement.error,
      sourceRefs: settlement.sourceRefs
    })
    yield* announce(record)
    return record
  })

  const settle: ScriptStore["Service"]["settle"] = (input) =>
    writer
      .transact(settleIn(input.ref, input.attempt, input.settlement))
      .pipe(Effect.mapError(storage("Could not settle the script", input.ref)))

  const cancel: ScriptStore["Service"]["cancel"] = (ref) =>
    writer
      .transact(
        Effect.gen(function* () {
          const record = yield* load(ref)
          if (record.status !== "running") return record
          yield* settleUnstartedToolWorkForTerminalInTransaction(
            sql,
            record.originRunId,
            DateTime.formatIso(yield* DateTime.now),
            "cancelled",
            { scriptToolCallId: record.originToolCallId }
          )
          const cancelled = yield* settleIn(ref, record.attempt, {
            status: "cancelled",
            value: null,
            error: cancelledError,
            sourceRefs: []
          })
          return cancelled ?? (yield* load(ref))
        })
      )
      .pipe(Effect.mapError(storage("Could not cancel the script", ref)))

  const progress: ScriptStore["Service"]["progress"] = (input) =>
    writer
      .transact(
        Effect.gen(function* () {
          const record = yield* load(input.ref)
          if (record.attempt !== input.attempt) return
          const prior = yield* readScriptExecutions(sql, record)
          const snapshots = Object.fromEntries(
            prior.map((entry) => [String(entry.attempt), entry.data])
          )
          const previous = snapshots[String(input.attempt)]
          const data = { ...input.data }
          for (const field of ["phases", "phase_entries", "agents", "tools"]) {
            const value = data[field]
            const priorValue = previous?.[field]
            if (
              Array.isArray(value) &&
              value.length === 0 &&
              Schema.is(Schema.Array(Schema.Json))(priorValue)
            ) {
              data[field] = priorValue
            }
          }
          snapshots[String(input.attempt)] = data
          yield* sql`UPDATE code_mode_scripts SET progress_json = ${JSON.stringify(snapshots)}
        WHERE script_ref = ${input.ref} AND attempt = ${input.attempt}`
        })
      )
      .pipe(Effect.mapError(storage("Could not save script progress", input.ref)))

  return ScriptStore.of({
    create,
    get,
    running,
    runningOfFencedRuns,
    nextAttempt,
    retry,
    settle,
    cancel,
    progress
  })
}
