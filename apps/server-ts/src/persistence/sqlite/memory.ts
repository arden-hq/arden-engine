import { DateTime, Effect, Schema } from "effect"

import {
  MemoryCaptureJobSchema,
  MemoryCaptureProgressSchema,
  PreparedMemoryCaptureBatchSchema,
  MemoryCaptureStore,
  MemoryCaptureStoreError,
  type MemoryCaptureJob
} from "../memory/store.js"
import {
  advanceMemoryCaptureInTransaction,
  prepareMemoryCaptureInTransaction,
  settleMemoryCaptureInTransaction
} from "./run-sidecar-mutations.js"
import type { PersistenceDeps } from "./deps.js"

interface PendingRow {
  readonly run_id: string
  readonly session_id: string
  readonly context_generation: number
  readonly through_sequence: number
  readonly processed_sequence: number | null
  readonly processed_offset: number | null
  readonly prepared_json: string | null
}

interface StoredCaptureRow {
  readonly status: string | null
  readonly stale: number
}

interface CursorRow {
  readonly sequence: number | null
}

const error = (
  operation: MemoryCaptureStoreError["operation"],
  message: string,
  input?: { readonly runId?: string; readonly sessionId?: string; readonly cause?: unknown }
) =>
  new MemoryCaptureStoreError({
    operation,
    message,
    ...(input?.runId === undefined ? {} : { runId: input.runId }),
    ...(input?.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause })
  })

export const makeMemoryCaptureStore = ({
  writer
}: Pick<PersistenceDeps, "writer">): MemoryCaptureStore["Service"] => {
  const sql = writer.sql
  const listPending = Effect.fn("SqliteMemoryCaptureStore.listPending")(function* (limit = 32) {
    const validLimit = yield* Schema.decodeUnknownEffect(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
    )(limit).pipe(
      Effect.mapError((cause) => error("list", "Invalid Memory capture page limit", { cause }))
    )
    const rows = yield* sql<PendingRow>`
      SELECT sidecar.run_id,
             sidecar.session_id,
             CAST(json_extract(sidecar.evidence_json, '$.memory_capture.context_generation') AS INTEGER)
               AS context_generation,
             CAST(json_extract(sidecar.evidence_json, '$.memory_capture.through_sequence') AS INTEGER)
               AS through_sequence,
             CAST(json_extract(sidecar.evidence_json, '$.memory_capture.progress.sequence') AS INTEGER)
               AS processed_sequence,
             CAST(json_extract(sidecar.evidence_json, '$.memory_capture.progress.offset') AS INTEGER)
               AS processed_offset,
             json_extract(sidecar.evidence_json, '$.memory_capture.prepared') AS prepared_json
      FROM run_sidecars AS sidecar
      JOIN sessions AS session ON session.session_id = sidecar.session_id
      WHERE json_extract(sidecar.evidence_json, '$.memory_capture.status') = 'pending'
        AND json_type(sidecar.evidence_json, '$.memory_capture.through_sequence') = 'integer'
        AND json_type(sidecar.evidence_json, '$.memory_capture.context_generation') = 'integer'
        AND CAST(json_extract(sidecar.evidence_json, '$.memory_capture.context_generation') AS INTEGER)
          = session.context_generation
        AND session.archived_at IS NULL
      ORDER BY sidecar.updated_at, sidecar.run_id
      LIMIT ${validLimit}
    `.pipe(
      Effect.mapError((cause) => error("list", "Could not list pending Memory captures", { cause }))
    )
    const jobs = yield* Effect.forEach(
      rows,
      Effect.fn("SqliteMemoryCaptureStore.jobs.row")(function* (row) {
        const prepared =
          row.prepared_json === null
            ? undefined
            : yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(PreparedMemoryCaptureBatchSchema)
              )(row.prepared_json)
        return {
          runId: row.run_id,
          sessionId: row.session_id,
          contextGeneration: row.context_generation,
          throughSequence: row.through_sequence,
          ...(row.processed_sequence === null || row.processed_offset === null
            ? {}
            : { progress: { sequence: row.processed_sequence, offset: row.processed_offset } }),
          ...(prepared === undefined ? {} : { prepared })
        }
      })
    ).pipe(
      Effect.mapError((cause) => error("list", "Stored Memory capture work is corrupt", { cause }))
    )
    return yield* Schema.decodeUnknownEffect(Schema.Array(MemoryCaptureJobSchema))(jobs).pipe(
      Effect.mapError((cause) => error("list", "Stored Memory capture work is corrupt", { cause }))
    )
  })

  const prepare = Effect.fn("SqliteMemoryCaptureStore.prepare")(function* (
    job: MemoryCaptureJob,
    prepared: unknown
  ) {
    const valid = yield* Schema.decodeUnknownEffect(MemoryCaptureJobSchema)(job).pipe(
      Effect.mapError((cause) =>
        error("prepare", "Invalid Memory capture job", {
          runId: job.runId,
          sessionId: job.sessionId,
          cause
        })
      )
    )
    const validPrepared = yield* Schema.decodeUnknownEffect(PreparedMemoryCaptureBatchSchema)(
      prepared
    ).pipe(
      Effect.mapError((cause) =>
        error("prepare", "Invalid prepared Memory capture batch", {
          runId: valid.runId,
          sessionId: valid.sessionId,
          cause
        })
      )
    )
    if (
      validPrepared.identity.sessionId !== valid.sessionId ||
      validPrepared.identity.contextGeneration !== valid.contextGeneration ||
      !validPrepared.runIds.includes(valid.runId)
    ) {
      return yield* error("prepare", "Prepared Memory capture does not own its leader", {
        runId: valid.runId,
        sessionId: valid.sessionId
      })
    }
    const now = DateTime.formatIso(yield* DateTime.now)
    const rows = yield* writer
      .run(
        prepareMemoryCaptureInTransaction(sql, {
          runId: valid.runId,
          sessionId: valid.sessionId,
          contextGeneration: valid.contextGeneration,
          throughSequence: valid.throughSequence,
          prepared: validPrepared,
          updatedAt: now
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          error("prepare", "Could not prepare Memory capture batch", {
            runId: valid.runId,
            sessionId: valid.sessionId,
            cause
          })
        )
      )
    if (rows.length !== 1) {
      return yield* error("prepare", "Memory capture preparation changed", {
        runId: valid.runId,
        sessionId: valid.sessionId
      })
    }
  })

  const cursor = Effect.fn("SqliteMemoryCaptureStore.cursor")(function* (
    sessionId: string,
    contextGeneration: number
  ) {
    const validSessionId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(sessionId).pipe(
      Effect.mapError((cause) =>
        error("cursor", "Invalid Memory capture Session", { sessionId, cause })
      )
    )
    const validGeneration = yield* Schema.decodeUnknownEffect(Schema.Natural)(
      contextGeneration
    ).pipe(
      Effect.mapError((cause) =>
        error("cursor", "Invalid Memory capture generation", {
          sessionId: validSessionId,
          cause
        })
      )
    )
    const rows = yield* sql<CursorRow>`
      SELECT MAX(CAST(json_extract(evidence_json, '$.memory_capture.through_sequence') AS INTEGER))
        AS sequence
      FROM run_sidecars
      WHERE session_id = ${validSessionId}
        AND json_extract(evidence_json, '$.memory_capture.status') IN ('done', 'skipped')
        AND CAST(json_extract(evidence_json, '$.memory_capture.context_generation') AS INTEGER)
          = ${validGeneration}
        AND json_type(evidence_json, '$.memory_capture.through_sequence') = 'integer'
    `.pipe(
      Effect.mapError((cause) =>
        error("cursor", "Could not read the Memory capture cursor", {
          sessionId: validSessionId,
          cause
        })
      )
    )
    const sequence = rows[0]?.sequence ?? -1
    if (!Number.isSafeInteger(sequence) || sequence < -1) {
      return yield* error("cursor", "Stored Memory capture cursor is corrupt", {
        sessionId: validSessionId
      })
    }
    return sequence
  })

  const storedCapture = (
    operation: "advance" | "complete",
    job: Pick<MemoryCaptureJob, "runId" | "sessionId">
  ) =>
    sql<StoredCaptureRow>`
      SELECT json_extract(sidecar.evidence_json, '$.memory_capture.status') AS status,
             CAST(json_extract(sidecar.evidence_json, '$.memory_capture.context_generation') AS INTEGER)
               != session.context_generation AS stale
      FROM run_sidecars AS sidecar
      JOIN sessions AS session ON session.session_id = sidecar.session_id
      WHERE sidecar.run_id = ${job.runId} AND sidecar.session_id = ${job.sessionId}
    `.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError((cause) =>
        error(operation, "Could not read Memory capture state", {
          runId: job.runId,
          sessionId: job.sessionId,
          cause
        })
      )
    )

  const advance = Effect.fn("SqliteMemoryCaptureStore.advance")(function* (
    job: MemoryCaptureJob,
    progress: unknown
  ) {
    const valid = yield* Schema.decodeUnknownEffect(MemoryCaptureJobSchema)(job).pipe(
      Effect.mapError((cause) =>
        error("advance", "Invalid Memory capture progress", {
          runId: job.runId,
          sessionId: job.sessionId,
          cause
        })
      )
    )
    const validProgress = yield* Schema.decodeUnknownEffect(MemoryCaptureProgressSchema)(
      progress
    ).pipe(
      Effect.mapError((cause) =>
        error("advance", "Invalid Memory capture progress sequence", {
          runId: valid.runId,
          sessionId: valid.sessionId,
          cause
        })
      )
    )
    if (validProgress.sequence > valid.throughSequence) {
      return yield* error("advance", "Memory capture progress exceeds its durable boundary", {
        runId: valid.runId,
        sessionId: valid.sessionId
      })
    }
    const now = DateTime.formatIso(yield* DateTime.now)
    const rows = yield* writer
      .run(
        advanceMemoryCaptureInTransaction(sql, {
          runId: valid.runId,
          sessionId: valid.sessionId,
          contextGeneration: valid.contextGeneration,
          throughSequence: valid.throughSequence,
          progress: validProgress,
          updatedAt: now
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          error("advance", "Could not advance Memory capture", {
            runId: valid.runId,
            sessionId: valid.sessionId,
            cause
          })
        )
      )
    if (rows.length === 1) return
    const row = yield* storedCapture("advance", valid)
    if (row !== undefined && (row.status !== "pending" || row.stale === 1)) {
      yield* Effect.logInfo("Memory capture superseded before it advanced", {
        runId: valid.runId,
        sessionId: valid.sessionId
      })
      return
    }
    return yield* error("advance", "Memory capture is no longer pending", {
      runId: valid.runId,
      sessionId: valid.sessionId
    })
  })

  const complete = Effect.fn("SqliteMemoryCaptureStore.complete")(function* (
    job: MemoryCaptureJob
  ) {
    const valid = yield* Schema.decodeUnknownEffect(MemoryCaptureJobSchema)(job).pipe(
      Effect.mapError((cause) =>
        error("complete", "Invalid Memory capture completion", {
          runId: job.runId,
          sessionId: job.sessionId,
          cause
        })
      )
    )
    const now = DateTime.formatIso(yield* DateTime.now)
    const rows = yield* writer
      .run(
        settleMemoryCaptureInTransaction(sql, {
          runId: valid.runId,
          sessionId: valid.sessionId,
          contextGeneration: valid.contextGeneration,
          throughSequence: valid.throughSequence,
          updatedAt: now
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          error("complete", "Could not complete Memory capture", {
            runId: valid.runId,
            sessionId: valid.sessionId,
            cause
          })
        )
      )
    if (rows.length === 1) return
    const row = yield* storedCapture("complete", valid)
    if (row === undefined || row.stale === 1) {
      yield* Effect.logInfo("Memory capture superseded before it settled", {
        runId: valid.runId,
        sessionId: valid.sessionId
      })
      return
    }
    return yield* error(
      "complete",
      row.status === "pending"
        ? "Memory capture is pending at another evidence boundary"
        : "Memory capture already settled with another outcome",
      { runId: valid.runId, sessionId: valid.sessionId }
    )
  })

  return MemoryCaptureStore.of({ listPending, cursor, prepare, advance, complete })
}
