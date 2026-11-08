import type { SqlClient, Statement } from "effect/unstable/sql"
import { captureMutationVersions } from "./mutation-links.js"
import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { assertIndependentConversation } from "./space-conversation.js"
import { DateTime, Effect, Schema } from "effect"
import {
  SessionStoreError,
  type ArchiveWhenIdle,
  type PendingArchive,
  type SessionStore
} from "../sessions/store.js"
import { deleteSessionTree } from "./session-tree-deletion.js"
import { automationsOfChat, deleteAutomationsOfChat } from "./automation-removal.js"
import type { PersistenceDeps } from "./deps.js"
import { storeError, sessionIdSchema } from "./session-rows.js"
import { activeRunStatusList } from "./status-sets.js"
import { chatArrivalWaitingSql } from "./chat-arrival-waiting.js"
import { userAutomationSql } from "./authority-sql.js"

export const chatHasActiveWork = (sql: SqlClient.SqlClient, session: Statement.Fragment) => sql`(
  EXISTS (SELECT 1 FROM chat_runs AS active_run
    WHERE active_run.session_id = ${session}.session_id
      AND active_run.status IN ${activeRunStatusList})
  OR EXISTS (SELECT 1 FROM code_mode_scripts AS active_script
    WHERE active_script.origin_session_ref = ${session}.public_ref
      AND active_script.status = 'running')
)`

export const makeSessionArchive = ({
  writer,
  reader,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "reader" | "sessionEvents">): Pick<
  SessionStore["Service"],
  "archive" | "restore" | "permanentDelete" | "archiveWhenIdle" | "pendingArchives"
> => {
  const sql = writer.sql
  const archive = Effect.fn("SqliteSessionStore.archive")(function* (
    sessionId: string,
    mutation?: MutationOperationIdentity
  ): Effect.fn.Return<boolean, SessionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(sessionIdSchema)(sessionId).pipe(
      Effect.mapError((cause) =>
        storeError("archive", "invalid", "Session id must not be empty", sessionId, cause)
      )
    )
    const now = yield* DateTime.now
    const archivedAt = DateTime.formatIso(now)

    return yield* writer
      .transact(
        Effect.gen(function* () {
          const recordVersions = yield* captureMutationVersions(sql, {
            domain: "session",
            id: validSessionId,
            identity: mutation
          })
          yield* assertIndependentConversation({
            sql,
            sessionId: validSessionId,
            operation: "archive"
          })
          const rows = yield* sql<{
            readonly session_id: string
            readonly has_active_work: number
          }>`
        SELECT s.session_id, ${chatHasActiveWork(sql, sql`s`)} AS has_active_work
        FROM sessions AS s
        WHERE s.session_id = ${validSessionId} AND s.archived_at IS NULL
        LIMIT 1
      `.pipe(
            Effect.mapError((cause) =>
              storeError(
                "archive",
                "storage",
                "Could not find session to archive",
                validSessionId,
                cause
              )
            )
          )
          const row = rows[0]
          if (row === undefined) return false
          if (row.has_active_work !== 0) {
            return yield* storeError(
              "archive",
              "conflict",
              "A Session with active work cannot be archived",
              validSessionId
            )
          }
          yield* sql`
        UPDATE sessions
        SET archived_at = ${archivedAt}
        WHERE session_id = ${validSessionId} AND archived_at IS NULL
      `.pipe(
            Effect.mapError((cause) =>
              storeError("archive", "storage", "Could not archive session", validSessionId, cause)
            )
          )
          const automations = yield* deleteAutomationsOfChat({
            sql,
            sessionEvents,
            sessionId: validSessionId
          })
          if (automations.kind === "running") {
            return yield* storeError(
              "archive",
              "conflict",
              `Wait for ${automations.names.join(", ")} to finish its run before archiving its chat`,
              validSessionId
            )
          }
          yield* recordVersions
          return true
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionStoreError
            ? cause
            : storeError(
                "archive",
                "storage",
                "Could not complete session archive",
                validSessionId,
                cause
              )
        )
      )
  })

  const restore = Effect.fn("SqliteSessionStore.restore")(function* (
    sessionId: string
  ): Effect.fn.Return<boolean, SessionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(sessionIdSchema)(sessionId).pipe(
      Effect.mapError((cause) =>
        storeError("restore", "invalid", "Session id must not be empty", sessionId, cause)
      )
    )

    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly session_id: string
            readonly archived_space: string | null
          }>`
        SELECT s.session_id,
          CASE WHEN space.archived_at IS NOT NULL THEN space.name END AS archived_space
        FROM sessions AS s LEFT JOIN spaces AS space ON space.space_id = s.space_id
        WHERE s.session_id = ${validSessionId} AND s.archived_at IS NOT NULL
        LIMIT 1
      `.pipe(
            Effect.mapError((cause) =>
              storeError(
                "restore",
                "storage",
                "Could not find session to restore",
                validSessionId,
                cause
              )
            )
          )
          const row = rows[0]
          if (row === undefined) return false
          if (row.archived_space !== null) {
            return yield* storeError(
              "restore",
              "conflict",
              `Restore the Space ${row.archived_space} to bring this chat back`,
              validSessionId
            )
          }
          yield* sql`
        UPDATE sessions
        SET archived_at = NULL
        WHERE session_id = ${validSessionId} AND archived_at IS NOT NULL
      `.pipe(
            Effect.mapError((cause) =>
              storeError("restore", "storage", "Could not restore session", validSessionId, cause)
            )
          )
          return true
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionStoreError
            ? cause
            : storeError(
                "restore",
                "storage",
                "Could not complete session restore",
                validSessionId,
                cause
              )
        )
      )
  })

  const permanentDelete = Effect.fn("SqliteSessionStore.permanentDelete")(function* (
    sessionId: string
  ): Effect.fn.Return<boolean, SessionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(sessionIdSchema)(sessionId).pipe(
      Effect.mapError((cause) =>
        storeError("delete", "invalid", "Session id must not be empty", sessionId, cause)
      )
    )

    return yield* writer
      .transact(
        Effect.gen(function* () {
          const deleted = yield* deleteSessionTree(
            sql,
            sessionEvents,
            sql`session_id = ${validSessionId} AND archived_at IS NOT NULL`
          )
          if (deleted.kind === "missing") return false
          if (deleted.kind === "active") {
            return yield* storeError(
              "delete",
              "conflict",
              "A Session with active work cannot be permanently deleted",
              validSessionId
            )
          }
          return true
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionStoreError
            ? cause
            : storeError(
                "delete",
                "storage",
                "Could not permanently delete session",
                validSessionId,
                cause
              )
        )
      )
  })

  const archiveWhenIdle = Effect.fn("SqliteSessionStore.archiveWhenIdle")(function* (
    sessionId: string,
    mutation: MutationOperationIdentity
  ): Effect.fn.Return<ArchiveWhenIdle, SessionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(sessionIdSchema)(sessionId).pipe(
      Effect.mapError((cause) =>
        storeError("archive", "invalid", "Session id must not be empty", sessionId, cause)
      )
    )
    const requestedAt = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          yield* assertIndependentConversation({
            sql,
            sessionId: validSessionId,
            operation: "archive"
          })
          const automations = yield* automationsOfChat(sql, validSessionId)
          if (automations.length > 0)
            return {
              kind: "automations",
              names: automations.map((automation) => automation.name)
            } as const
          const rows = yield* sql<{ readonly session_id: string }>`
            INSERT INTO session_pending_archives (session_id, run_id, tool_call_id, requested_at)
            SELECT session_id, ${mutation.runId}, ${mutation.toolCallId}, ${requestedAt}
            FROM sessions WHERE session_id = ${validSessionId} AND archived_at IS NULL
            ON CONFLICT (session_id) DO UPDATE SET run_id = excluded.run_id,
              tool_call_id = excluded.tool_call_id, requested_at = excluded.requested_at
            RETURNING session_id
          `
          return rows.length > 0 ? ({ kind: "kept" } as const) : ({ kind: "gone" } as const)
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionStoreError
            ? cause
            : storeError(
                "archive",
                "storage",
                "Could not keep the chat's archive for when its work ends",
                validSessionId,
                cause
              )
        )
      )
  })

  const pendingArchives = Effect.fn("SqliteSessionStore.pendingArchives")(function* () {
    yield* writer
      .transact(
        sql`DELETE FROM session_pending_archives
          WHERE EXISTS (SELECT 1 FROM scheduled_tasks AS task
            WHERE task.thread_id = session_pending_archives.session_id
              AND ${userAutomationSql("task")})`
      )
      .pipe(
        Effect.mapError((cause) =>
          storeError(
            "archive",
            "storage",
            "Could not keep chats with Automations open",
            undefined,
            cause
          )
        )
      )
    const rows = yield* reader<{
      readonly session_id: string
      readonly run_id: string
      readonly tool_call_id: string
    }>`
      SELECT pending.session_id, pending.run_id, pending.tool_call_id
      FROM session_pending_archives AS pending
      WHERE NOT ${chatArrivalWaitingSql(reader, reader`pending.session_id`)}
      ORDER BY pending.requested_at, pending.session_id
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          "archive",
          "storage",
          "Could not read the chats waiting to archive",
          undefined,
          cause
        )
      )
    )
    return rows.map((row): PendingArchive => ({
      sessionId: row.session_id,
      mutation: { runId: row.run_id, toolCallId: row.tool_call_id }
    }))
  })

  return { archive, restore, permanentDelete, archiveWhenIdle, pendingArchives }
}
