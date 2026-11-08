import { backoffDelayMs } from "@arden-hq/std/retry"
import { DateTime, Effect } from "effect"

import { ManagedOutputLifecycleStore } from "../managed-output/lifecycle-store.js"
import { CHAT_UPLOAD_MESSAGES_BACKFILL } from "./chat-upload-messages.js"
import type { PersistenceDeps } from "./deps.js"
import { makeManagedOutputFence } from "./managed-output-fence.js"

const UPLOAD_REMOVAL_TRIES = 5

export const makeManagedOutputLifecycleStore = ({
  writer,
  reader
}: Pick<PersistenceDeps, "writer" | "reader">): ManagedOutputLifecycleStore["Service"] => {
  const sql = writer.sql
  const fence = makeManagedOutputFence(writer)
  const liveSession = (sessionId: string) =>
    writer.snapshot(reader`SELECT session_id FROM sessions WHERE session_id = ${sessionId}`)
  const withLiveSession: ManagedOutputLifecycleStore["Service"]["withLiveSession"] = (
    sessionId,
    action
  ) =>
    fence.run(async () => {
      if ((await Effect.runPromise(liveSession(sessionId))).length !== 1)
        throw new Error("Managed-output Session no longer exists")
      const result = await action()
      if ((await Effect.runPromise(liveSession(sessionId))).length !== 1)
        throw new Error("Managed-output Session no longer exists")
      return result
    })

  const pendingCleanup: ManagedOutputLifecycleStore["Service"]["pendingCleanup"] = () =>
    Effect.runPromise(
      writer.snapshot(reader<{ readonly session_id: string }>`
        SELECT cleanup.session_id FROM session_file_cleanup AS cleanup
        WHERE NOT EXISTS (SELECT 1 FROM session_fork_requests AS fork
          WHERE fork.source_session_id = cleanup.session_id AND fork.state = 'preparing')
        ORDER BY cleanup.queued_at, cleanup.session_id LIMIT 64`)
    ).then((rows) => rows.map((row) => row.session_id))

  const cleanupSession: ManagedOutputLifecycleStore["Service"]["cleanupSession"] = (input) =>
    fence.run(async () => {
      const pending = await Effect.runPromise(
        writer.snapshot(reader`SELECT session_id FROM session_file_cleanup
          WHERE session_id = ${input.sessionId}
            AND NOT EXISTS (SELECT 1 FROM session_fork_requests AS fork
              WHERE fork.source_session_id = ${input.sessionId} AND fork.state = 'preparing')`)
      )
      if (pending.length === 0) return false
      if ((await Effect.runPromise(liveSession(input.sessionId))).length !== 0)
        throw new Error("File cleanup cannot remove a live Session")
      const digests = await input.ownerDigests()
      for (let offset = 0; offset < digests.length; offset += 64) {
        await Effect.runPromise(
          writer.transact(
            Effect.gen(function* () {
              for (const digest of digests.slice(offset, offset + 64)) {
                yield* sql`INSERT INTO managed_output_gc_candidates (session_id, sha256)
                VALUES (${input.sessionId}, ${digest}) ON CONFLICT(session_id, sha256) DO NOTHING`
              }
            })
          )
        )
      }
      await input.remove()
      await Effect.runPromise(
        writer.transact(sql`DELETE FROM session_file_cleanup
        WHERE session_id = ${input.sessionId}`)
      )
      return true
    })

  const forgetOutput: ManagedOutputLifecycleStore["Service"]["forgetOutput"] = (input) =>
    fence.run(async () => {
      if ((await Effect.runPromise(liveSession(input.sessionId))).length !== 1)
        throw new Error("Managed-output Session no longer exists")
      await Effect.runPromise(
        writer.transact(sql`INSERT INTO managed_output_gc_candidates (session_id, sha256)
          VALUES (${input.sessionId}, ${input.digest}) ON CONFLICT(session_id, sha256) DO NOTHING`)
      )
      return input.remove()
    })

  const pendingGc: ManagedOutputLifecycleStore["Service"]["pendingGc"] = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rows = yield* reader<{ readonly session_id: string; readonly sha256: string }>`
        SELECT candidate.session_id, candidate.sha256
        FROM managed_output_gc_candidates AS candidate
        WHERE NOT EXISTS (SELECT 1 FROM session_file_cleanup AS cleanup
          WHERE cleanup.session_id = candidate.session_id)
        ORDER BY candidate.session_id, candidate.sha256 LIMIT 64`
        return rows.map((row) => ({ sessionId: row.session_id, digest: row.sha256 }))
      })
    )

  const completeGc: ManagedOutputLifecycleStore["Service"]["completeGc"] = (
    sessionId,
    digest,
    action
  ) =>
    fence.run(async () => {
      const rows = await Effect.runPromise(
        writer.snapshot(reader`
      SELECT candidate.sha256 FROM managed_output_gc_candidates AS candidate
      WHERE candidate.session_id = ${sessionId} AND candidate.sha256 = ${digest}
        AND NOT EXISTS (SELECT 1 FROM session_file_cleanup AS cleanup
          WHERE cleanup.session_id = candidate.session_id)`)
      )
      if (rows.length === 0) return false
      await action()
      await Effect.runPromise(
        writer.transact(sql`DELETE FROM managed_output_gc_candidates
      WHERE session_id = ${sessionId} AND sha256 = ${digest}`)
      )
      return true
    })

  const pendingUploads: ManagedOutputLifecycleStore["Service"]["pendingUploads"] = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now)
        const rows = yield* reader<{ readonly upload_id: string }>`
        SELECT upload_id FROM chat_upload_cleanup
        WHERE retry_after IS NULL OR retry_after <= ${now}
        ORDER BY queued_at, upload_id LIMIT 64`
        return rows.map((row) => row.upload_id)
      })
    )

  const queueUploads: ManagedOutputLifecycleStore["Service"]["queueUploads"] = (uploadIds) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now)
        for (let offset = 0; offset < uploadIds.length; offset += 64) {
          yield* writer.transact(
            Effect.gen(function* () {
              for (const uploadId of uploadIds.slice(offset, offset + 64)) {
                yield* sql`INSERT INTO chat_upload_cleanup (upload_id, queued_at)
              VALUES (${uploadId}, ${now}) ON CONFLICT(upload_id) DO NOTHING`
              }
            })
          )
        }
      })
    )

  const decideUpload: ManagedOutputLifecycleStore["Service"]["decideUpload"] = (uploadId) =>
    Effect.runPromise(
      writer.transact(
        Effect.gen(function* () {
          const queued = yield* sql<{ readonly upload_id: string }>`
        SELECT upload_id FROM chat_upload_cleanup WHERE upload_id = ${uploadId}`
          if (queued.length === 0) return "gone" as const
          const listed = yield* sql<{ readonly done: number }>`
        SELECT 1 AS done FROM data_backfills
        WHERE name = ${CHAT_UPLOAD_MESSAGES_BACKFILL} AND finished_at IS NOT NULL`
          if (listed.length === 0) return "wait" as const
          const needle = `/uploads/${uploadId}/`
          const named = yield* sql<{ readonly named: number }>`
        SELECT 1 AS named FROM chat_upload_messages AS listed
        JOIN session_messages AS m ON m.message_rowid = listed.message_rowid
        WHERE m.role = 'user' AND instr(m.message_json, ${needle}) > 0
        UNION ALL
        SELECT 1 AS named FROM session_queued_messages WHERE instr(message, ${needle}) > 0
        LIMIT 1`
          if (named.length === 0) return "remove" as const
          yield* sql`DELETE FROM chat_upload_cleanup WHERE upload_id = ${uploadId}`
          return "kept" as const
        })
      )
    )

  const finishUpload: ManagedOutputLifecycleStore["Service"]["finishUpload"] = (uploadId) =>
    Effect.runPromise(
      writer.transact(sql`DELETE FROM chat_upload_cleanup WHERE upload_id = ${uploadId}`)
    ).then(() => undefined)

  const deferUpload: ManagedOutputLifecycleStore["Service"]["deferUpload"] = (uploadId) =>
    Effect.runPromise(
      writer.transact(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly failures: number }>`
        SELECT failures FROM chat_upload_cleanup WHERE upload_id = ${uploadId}`
          const failures = (rows[0]?.failures ?? 0) + 1
          if (rows.length === 0 || failures >= UPLOAD_REMOVAL_TRIES) {
            yield* sql`DELETE FROM chat_upload_cleanup WHERE upload_id = ${uploadId}`
            return false
          }
          const retryAfter = DateTime.formatIso(
            DateTime.add(yield* DateTime.now, {
              milliseconds: backoffDelayMs({ initialMs: 3_600_000, maxMs: Infinity }, failures)
            })
          )
          yield* sql`UPDATE chat_upload_cleanup
        SET failures = ${failures}, retry_after = ${retryAfter}
        WHERE upload_id = ${uploadId}`
          return true
        })
      )
    )

  return ManagedOutputLifecycleStore.of({
    withLiveSession,
    pendingCleanup,
    cleanupSession,
    drain: fence.drain,
    forgetOutput,
    pendingGc,
    completeGc,
    pendingUploads,
    queueUploads,
    decideUpload,
    finishUpload,
    deferUpload
  })
}
