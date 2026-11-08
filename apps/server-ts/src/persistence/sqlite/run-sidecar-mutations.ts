import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import type { PreparedMemoryCaptureBatch } from "../memory/store.js"
import { userChatSql } from "./chat-ownership.js"

interface RunSidecarIdentity {
  readonly runId: string
  readonly sessionId: string
}

interface MemoryCaptureBoundary extends RunSidecarIdentity {
  readonly contextGeneration: number
  readonly throughSequence: number
}

export const reserveMemoryCaptureInTransaction = Effect.fn("RunSidecars.reserveMemoryCapture")(
  function* (
    sql: SqlClient.SqlClient,
    input: MemoryCaptureBoundary & {
      readonly updatedAt: string
    }
  ) {
    const capture = JSON.stringify({
      status: "pending",
      context_generation: input.contextGeneration,
      through_sequence: input.throughSequence
    })
    yield* sql`
      INSERT INTO run_sidecars (
        run_id, session_id, context_manifest_json, source_refs_json,
        evidence_json, updated_at
      )
      SELECT ${input.runId}, ${input.sessionId}, '[]', '[]',
             json_object('memory_capture', json(${capture})), ${input.updatedAt}
      FROM sessions
      WHERE session_id = ${input.sessionId}
        AND ${userChatSql()}
        AND archived_at IS NULL
      ON CONFLICT(run_id) DO UPDATE SET
        session_id = excluded.session_id,
        evidence_json = json_set(
          run_sidecars.evidence_json,
          '$.memory_capture',
          json(${capture})
        ),
        updated_at = excluded.updated_at
    `
  }
)

export const recordBlockedAutomationInTransaction = Effect.fn(
  "RunSidecars.recordBlockedAutomation"
)(function* (
  sql: SqlClient.SqlClient,
  input: RunSidecarIdentity & {
    readonly kind: string
    readonly reason: string
    readonly updatedAt: string
  }
) {
  const outcome = JSON.stringify({ status: "blocked", kind: input.kind, reason: input.reason })
  yield* sql`
      INSERT INTO run_sidecars (
        run_id, session_id, context_manifest_json, source_refs_json,
        evidence_json, updated_at
      ) VALUES (
        ${input.runId}, ${input.sessionId}, '[]', '[]',
        json_object('automation_outcome', json(${outcome})), ${input.updatedAt}
      )
      ON CONFLICT(run_id) DO UPDATE SET
        evidence_json = json_set(
          run_sidecars.evidence_json,
          '$.automation_outcome',
          json(${outcome})
        ),
        updated_at = excluded.updated_at
    `
})

export const advanceMemoryCaptureInTransaction = Effect.fn("RunSidecars.advanceMemoryCapture")(
  function* (
    sql: SqlClient.SqlClient,
    input: MemoryCaptureBoundary & {
      readonly progress: { readonly sequence: number; readonly offset: number }
      readonly updatedAt: string
    }
  ) {
    const progress = JSON.stringify(input.progress)
    return yield* sql<{ readonly run_id: string }>`
      UPDATE run_sidecars
      SET evidence_json = json_remove(json_set(
            evidence_json,
            '$.memory_capture.progress',
            json(CASE
              WHEN COALESCE(CAST(json_extract(evidence_json, '$.memory_capture.progress.sequence') AS INTEGER), -1) > ${input.progress.sequence}
                OR (
                  COALESCE(CAST(json_extract(evidence_json, '$.memory_capture.progress.sequence') AS INTEGER), -1) = ${input.progress.sequence}
                  AND COALESCE(CAST(json_extract(evidence_json, '$.memory_capture.progress.offset') AS INTEGER), 0) >= ${input.progress.offset}
                )
              THEN json_extract(evidence_json, '$.memory_capture.progress')
              ELSE ${progress}
            END)
          ), '$.memory_capture.prepared'),
          updated_at = ${input.updatedAt}
      WHERE run_id = ${input.runId}
        AND session_id = ${input.sessionId}
        AND json_extract(evidence_json, '$.memory_capture.status') = 'pending'
        AND CAST(json_extract(evidence_json, '$.memory_capture.context_generation') AS INTEGER)
          = (SELECT context_generation FROM sessions WHERE session_id = ${input.sessionId})
        AND CAST(json_extract(evidence_json, '$.memory_capture.through_sequence') AS INTEGER)
          = ${input.throughSequence}
      RETURNING run_id
    `
  }
)

export const prepareMemoryCaptureInTransaction = Effect.fn("RunSidecars.prepareMemoryCapture")(
  function* (
    sql: SqlClient.SqlClient,
    input: MemoryCaptureBoundary & {
      readonly prepared: PreparedMemoryCaptureBatch
      readonly updatedAt: string
    }
  ) {
    const prepared = JSON.stringify(input.prepared)
    return yield* sql<{ readonly run_id: string }>`
      UPDATE run_sidecars
      SET evidence_json = json_set(
            evidence_json,
            '$.memory_capture.prepared',
            json(${prepared})
          ),
          updated_at = ${input.updatedAt}
      WHERE run_id = ${input.runId}
        AND session_id = ${input.sessionId}
        AND json_extract(evidence_json, '$.memory_capture.status') = 'pending'
        AND CAST(json_extract(evidence_json, '$.memory_capture.context_generation') AS INTEGER)
          = (SELECT context_generation FROM sessions WHERE session_id = ${input.sessionId})
        AND CAST(json_extract(evidence_json, '$.memory_capture.through_sequence') AS INTEGER)
          = ${input.throughSequence}
        AND (
          json_type(evidence_json, '$.memory_capture.prepared') IS NULL
          OR json_extract(evidence_json, '$.memory_capture.prepared') = json(${prepared})
        )
      RETURNING run_id
    `
  }
)

export const settleMemoryCaptureInTransaction = Effect.fn("RunSidecars.settleMemoryCapture")(
  function* (
    sql: SqlClient.SqlClient,
    input: MemoryCaptureBoundary & {
      readonly updatedAt: string
    }
  ) {
    const replacement = JSON.stringify({ status: "done", through_sequence: input.throughSequence })
    return yield* sql<{ readonly run_id: string }>`
      UPDATE run_sidecars
      SET evidence_json = json_set(
            evidence_json,
            '$.memory_capture',
            json_set(
              json(${replacement}),
              '$.context_generation',
              (SELECT context_generation FROM sessions WHERE session_id = ${input.sessionId})
            )
          ),
          updated_at = ${input.updatedAt}
      WHERE run_id = ${input.runId}
        AND session_id = ${input.sessionId}
        AND (json_extract(evidence_json, '$.memory_capture.status') = 'pending'
          OR (json_extract(evidence_json, '$.memory_capture.status') = 'done'
            AND json_extract(evidence_json, '$.memory_capture.reason') IS NULL))
        AND CAST(json_extract(evidence_json, '$.memory_capture.context_generation') AS INTEGER)
          = (SELECT context_generation FROM sessions WHERE session_id = ${input.sessionId})
        AND CAST(json_extract(evidence_json, '$.memory_capture.through_sequence') AS INTEGER)
          = ${input.throughSequence}
      RETURNING run_id
    `
  }
)

export const moveMemoryCaptureContextInTransaction = Effect.fn(
  "RunSidecars.moveMemoryCaptureContext"
)(function* (
  sql: SqlClient.SqlClient,
  input: { readonly sessionId: string; readonly from: number; readonly to: number }
) {
  yield* sql`
    UPDATE run_sidecars
    SET evidence_json = json_set(
          evidence_json,
          '$.memory_capture.context_generation',
          ${input.to}
        )
    WHERE session_id = ${input.sessionId}
      AND json_type(evidence_json, '$.memory_capture') = 'object'
      AND CAST(json_extract(evidence_json, '$.memory_capture.context_generation') AS INTEGER)
        = ${input.from}
  `
})

export const deleteRunSidecarsBySessionInTransaction = Effect.fn("RunSidecars.deleteBySession")(
  function* (sql: SqlClient.SqlClient, sessionId: string) {
    yield* sql`DELETE FROM run_sidecars WHERE session_id = ${sessionId}`
  }
)
