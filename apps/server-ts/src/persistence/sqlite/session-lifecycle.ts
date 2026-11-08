import { captureMutationVersions } from "./mutation-links.js"
import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { IsoDateTimeStringSchema } from "@arden-hq/protocol/effect/common"
import {
  SessionStoreError,
  type CreatedSession,
  type NewSession,
  type OwnChatMove,
  type SessionStore
} from "../sessions/store.js"
import { SessionLifecycleEvents } from "../sessions/events.js"
import { friendlySessionRef } from "../public-ref.js"
import { nextId } from "./deps.js"
import { insertSession } from "./session-insert.js"
import type { PersistenceDeps } from "./deps.js"
import { storeError, sessionIdSchema, sessionNameSchema } from "./session-rows.js"
import { moveConversationInTransaction } from "./session-space-move.js"
import { sessionOriginQuery } from "./session-origin.js"

const SessionCreateRowSchema = Schema.Struct({
  session_id: Schema.NonEmptyString,
  name: Schema.NullOr(Schema.String),
  started_at: IsoDateTimeStringSchema,
  last_activity: IsoDateTimeStringSchema,
  message_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  space_id: Schema.NullOr(Schema.String),
  chat_model: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.Literals(["capture", "onboarding"]))
})

type SessionCreateRow = (typeof SessionCreateRowSchema)["Encoded"]

const createdSession = Effect.fn("SqliteSessionStore.createdSession")(function* (
  raw: SessionCreateRow
): Effect.fn.Return<CreatedSession, SessionStoreError> {
  const row = yield* Schema.decodeUnknownEffect(SessionCreateRowSchema)(raw).pipe(
    Effect.mapError((cause) =>
      storeError(
        "create",
        "storage",
        "Stored session create response is corrupt",
        raw.session_id,
        cause
      )
    )
  )
  return {
    sessionId: row.session_id,
    name: row.name ?? undefined,
    startedAt: row.started_at,
    lastActivity: row.last_activity,
    messageCount: row.message_count,
    spaceId: row.space_id ?? undefined,
    chatModel: row.chat_model ?? undefined,
    origin: row.origin ?? undefined
  }
})

const createRow = Effect.fn("SqliteSessionStore.createRow")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const rows = yield* sql<SessionCreateRow>`
    SELECT s.session_id, s.name, s.started_at, s.last_activity,
           s.active_message_count AS message_count, s.space_id, s.chat_model,
           ${sql.literal(sessionOriginQuery)} AS origin
    FROM sessions AS s
    WHERE s.session_id = ${sessionId}
    LIMIT 1
  `
  const row = rows[0]
  return row === undefined
    ? yield* storeError("create", "storage", "Created session could not be read", sessionId)
    : row
})

export const createSessionInTransaction = Effect.fn("SqliteSessionStore.createInTransaction")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly sessionEvents: SessionLifecycleEvents["Service"]
    readonly sessionId: string
    readonly timestamp: string
    readonly session: NewSession
  }) {
    const { sql, sessionEvents, sessionId, timestamp, session } = options
    const name = session.name?.trim() || null
    const spaceId = session.spaceId ?? null
    if (spaceId !== null) {
      const spaces = yield* sql<{ readonly space_id: string }>`SELECT space_id
      FROM spaces
      WHERE space_id = ${spaceId} AND archived_at IS NULL
      LIMIT 1`.pipe(
        Effect.mapError((cause) =>
          storeError("create", "storage", "Could not validate the Space", undefined, cause)
        )
      )
      if (spaces.length === 0) {
        return yield* storeError("create", "not_found", "Space not found", undefined)
      }
    }

    const row = yield* insertSession({
      sql,
      session: {
        type: "chat",
        sessionId,
        publicRef: friendlySessionRef(sessionId),
        startedAt: timestamp,
        name,
        metadata: JSON.stringify({
          ...(session.origin === undefined ? {} : { [session.origin]: { at: timestamp } }),
          ...(session.commandLine === true ? { cli: { at: timestamp } } : {})
        }),
        spaceId,
        chatModel: null,
        originAutomationId: null,
        parent: null
      },
      lifecycle: {
        kind: "announce",
        events: sessionEvents,
        complete: createRow(sql, sessionId).pipe(
          Effect.mapError((cause) =>
            cause instanceof SessionStoreError
              ? cause
              : storeError("create", "storage", "Could not read created session", sessionId, cause)
          )
        )
      }
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        storeError("create", "storage", "Could not create session", sessionId, cause)
      )
    )
    return yield* createdSession(row)
  }
)

export const makeSessionLifecycle = ({
  writer,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "sessionEvents">): Pick<
  SessionStore["Service"],
  "create" | "commandLineChat" | "rename" | "renameIfEmpty" | "moveToSpace" | "moveFromRun"
> => {
  const sql = writer.sql
  const commandLineChat = Effect.fn("SqliteSessionStore.commandLineChat")(function* (
    target: { readonly sessionId: string } | { readonly runId: string }
  ): Effect.fn.Return<boolean, SessionStoreError> {
    const rows = yield* (
      "sessionId" in target
        ? sql<{ readonly cli: number }>`
            SELECT json_extract(s.metadata, '$.cli.at') IS NOT NULL AS cli
            FROM sessions AS s WHERE s.session_id = ${target.sessionId}`
        : sql<{ readonly cli: number }>`
            SELECT json_extract(s.metadata, '$.cli.at') IS NOT NULL AS cli
            FROM chat_runs AS r JOIN sessions AS s ON s.session_id = r.session_id
            WHERE r.run_id = ${target.runId}`
    ).pipe(
      Effect.mapError((cause) =>
        storeError("list", "storage", "Could not read the chat's maker", undefined, cause)
      )
    )
    return rows[0]?.cli === 1
  })
  const create = Effect.fn("SqliteSessionStore.create")(function* (
    session: NewSession
  ): Effect.fn.Return<CreatedSession, SessionStoreError> {
    const sessionId = yield* nextId
    const now = yield* DateTime.now
    const timestamp = DateTime.formatIso(now)
    return yield* writer
      .transact(
        createSessionInTransaction({
          sql,
          sessionEvents,
          sessionId,
          timestamp,
          session
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionStoreError
            ? cause
            : storeError(
                "create",
                "storage",
                "Could not complete session creation",
                sessionId,
                cause
              )
        )
      )
  })

  const rename = Effect.fn("SqliteSessionStore.rename")(function* (
    sessionId: string,
    name: string,
    mutation?: MutationOperationIdentity
  ): Effect.fn.Return<string | undefined, SessionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(sessionIdSchema)(sessionId).pipe(
      Effect.mapError((cause) =>
        storeError("rename", "invalid", "Session id must not be empty", sessionId, cause)
      )
    )
    const validName = yield* Schema.decodeUnknownEffect(sessionNameSchema)(name.trim()).pipe(
      Effect.mapError((cause) =>
        storeError("rename", "invalid", "Session name must not be empty", validSessionId, cause)
      )
    )

    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly session_id: string }>`
        SELECT session_id
        FROM sessions
        WHERE session_id = ${validSessionId} AND archived_at IS NULL
        LIMIT 1
      `.pipe(
            Effect.mapError((cause) =>
              storeError(
                "rename",
                "storage",
                "Could not find session to rename",
                validSessionId,
                cause
              )
            )
          )
          if (rows.length === 0) return undefined
          const recordVersions = yield* captureMutationVersions(sql, {
            domain: "session",
            id: validSessionId,
            identity: mutation
          })
          yield* sql`
        UPDATE sessions
        SET name = ${validName}
        WHERE session_id = ${validSessionId} AND archived_at IS NULL
      `.pipe(
            Effect.mapError((cause) =>
              storeError("rename", "storage", "Could not rename session", validSessionId, cause)
            )
          )
          yield* recordVersions
          return validName
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionStoreError
            ? cause
            : storeError(
                "rename",
                "storage",
                "Could not complete session rename",
                validSessionId,
                cause
              )
        )
      )
  })

  const renameIfEmpty = Effect.fn("SqliteSessionStore.renameIfEmpty")(function* (
    sessionId: string,
    name: string
  ): Effect.fn.Return<boolean, SessionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(sessionIdSchema)(sessionId).pipe(
      Effect.mapError((cause) =>
        storeError("rename", "invalid", "Session id must not be empty", sessionId, cause)
      )
    )
    const validName = yield* Schema.decodeUnknownEffect(sessionNameSchema)(name.trim()).pipe(
      Effect.mapError((cause) =>
        storeError("rename", "invalid", "Session name must not be empty", validSessionId, cause)
      )
    )

    return yield* writer
      .transactInteractive(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly session_id: string }>`
            UPDATE sessions
            SET name = ${validName}
            WHERE session_id = ${validSessionId}
              AND archived_at IS NULL
              AND (name IS NULL OR trim(name) = '')
            RETURNING session_id
          `.pipe(
            Effect.mapError((cause) =>
              storeError(
                "rename",
                "storage",
                "Could not generate Session name",
                validSessionId,
                cause
              )
            )
          )
          return rows.length > 0
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionStoreError
            ? cause
            : storeError(
                "rename",
                "storage",
                "Could not complete session rename",
                validSessionId,
                cause
              )
        )
      )
  })

  const moveToSpace = Effect.fn("SqliteSessionStore.moveToSpace")(function* (
    sessionId: string,
    spaceId: string | undefined
  ): Effect.fn.Return<boolean, SessionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(sessionIdSchema)(sessionId).pipe(
      Effect.mapError((cause) =>
        storeError("move", "invalid", "Session id must not be empty", sessionId, cause)
      )
    )
    const validSpaceId = yield* Schema.decodeUnknownEffect(Schema.NullOr(Schema.NonEmptyString))(
      spaceId ?? null
    ).pipe(
      Effect.mapError((cause) =>
        storeError("move", "invalid", "Space id must not be empty", validSessionId, cause)
      )
    )

    const moved = yield* writer
      .transact(
        moveConversationInTransaction({
          sql,
          sessionId: validSessionId,
          spaceId: validSpaceId ?? undefined,
          askingRunId: undefined
        })
      )
      .pipe(Effect.mapError(moveFailure(validSessionId)))
    return moved.kind !== "missing"
  })

  const moveFromRun = Effect.fn("SqliteSessionStore.moveFromRun")(function* (
    runId: string,
    spaceId: string | undefined,
    toolCallId?: string
  ): Effect.fn.Return<OwnChatMove | undefined, SessionStoreError> {
    const runs = yield* sql<{ readonly session_id: string }>`
      SELECT session_id FROM chat_runs WHERE run_id = ${runId} LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError("move", "storage", "Could not find the run's Chat", undefined, cause)
      )
    )
    const sessionId = runs[0]?.session_id
    if (sessionId === undefined) return undefined
    const moved = yield* writer
      .transact(
        moveConversationInTransaction({
          sql,
          sessionId,
          spaceId,
          askingRunId: runId,
          mutation: toolCallId === undefined ? undefined : { runId, toolCallId }
        })
      )
      .pipe(Effect.mapError(moveFailure(sessionId)))
    switch (moved.kind) {
      case "missing":
        return undefined
      case "moved":
        return { when: "now", spaceName: moved.spaceName }
      case "on_run_end":
        return { when: "run_end", spaceName: moved.spaceName }
    }
  })

  return { create, commandLineChat, rename, renameIfEmpty, moveToSpace, moveFromRun }
}

const moveFailure = (sessionId: string) => (cause: unknown) =>
  cause instanceof SessionStoreError
    ? cause
    : storeError("move", "storage", "Could not complete the session move", sessionId, cause)
