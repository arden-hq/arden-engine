import { journalHeadSequenceSql } from "@arden-hq/journal/effect"
import { SESSION_LIFECYCLE_STREAM_ID } from "../sessions/events.js"
import type {
  BrowserScope,
  BrowserScopeInput,
  BrowserScopeSnapshot
} from "@arden-hq/protocol/browser-scope"
import { cutText } from "@arden-hq/std/text"
import { readSessionToolEvidence } from "./chat-action-evidence.js"
import type { JobPurpose } from "../job-classification.js"
import { Effect, Schema } from "effect"
import {
  SessionQueries,
  SessionDataCorruptionError,
  SessionQueryError
} from "../sessions/queries.js"
import {
  ActiveSessionSnapshotSchema,
  AgentChildReferenceSchema,
  SessionHistoryHeaderSchema,
  type SessionHeaderSnapshot,
  type SessionNameImage,
  type SessionNameSeed
} from "../sessions/model.js"
import { StoredMessageEnvelopeSchema, type StoredMessageEnvelope } from "../transcript/model.js"
import { JsonObjectSchema } from "../json.js"
import { readCapture } from "../sessions/capture.js"
import { decodeJson } from "./json.js"
import { sessionBlockingWorkPredicate } from "./session-blocking-work.js"
import type { PersistenceDeps } from "./deps.js"
import { OptionalInputTokens } from "./session-rows.js"
import { ActiveContextError, loadActiveContext } from "./active-context.js"
import { activeRunStatusList } from "./status-sets.js"
import { sessionForkOriginFromMetadata } from "../sessions/fork-origin.js"

interface SessionRow {
  readonly session_id: string
  readonly public_ref: string
  readonly started_at: string
  readonly last_activity: string
  readonly metadata: string | null
  readonly name: string | null
  readonly session_type: string | null
  readonly origin_automation_id: string | null
  readonly parent_session_id: string | null
  readonly parent_run_id: string | null
  readonly parent_tool_call_id: string | null
  readonly parent_message_id: string | null
  readonly space_id: string | null
  readonly chat_model: string | null
  readonly context_generation: number
  readonly active_message_count: number
}

const corruption = (
  sessionId: string,
  message: string,
  cause?: unknown
): SessionDataCorruptionError =>
  new SessionDataCorruptionError({
    sessionId,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const queryError = (
  operation:
    | "load"
    | "history_header"
    | "agent_children"
    | "name_seed"
    | "space_work_origin"
    | "blocking_work"
    | "session_ref"
    | "tool_evidence"
    | "space_chats"
    | "browser_scope",
  message: string,
  cause?: unknown
): SessionQueryError =>
  new SessionQueryError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export const makeSessionQueries = ({
  reader,
  writer
}: Pick<PersistenceDeps, "reader" | "writer">): SessionQueries["Service"] => {
  const sql = reader
  const snapshot = writer.snapshot
  const find = Effect.fn("SqliteSessionQueries.find")(function* (sessionId?: string) {
    return yield* sessionId === undefined
      ? sql<SessionRow>`
        SELECT session_id, public_ref, started_at, last_activity, metadata, name,
               session_type, origin_automation_id, parent_session_id, parent_run_id,
               parent_tool_call_id, parent_message_id, space_id, chat_model,
               context_generation, active_message_count
        FROM sessions
        WHERE archived_at IS NULL
        ORDER BY last_activity DESC, session_id DESC
        LIMIT 1
      `
      : sql<SessionRow>`
        SELECT session_id, public_ref, started_at, last_activity, metadata, name,
               session_type, origin_automation_id, parent_session_id, parent_run_id,
               parent_tool_call_id, parent_message_id, space_id, chat_model,
               context_generation, active_message_count
        FROM sessions
        WHERE session_id = ${sessionId}
        LIMIT 1
      `
  })

  const headerSnapshot = Effect.fn("SqliteSessionQueries.headerSnapshot")(function* (
    row: SessionRow
  ): Effect.fn.Return<SessionHeaderSnapshot, SessionDataCorruptionError> {
    const startedAt = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
      row.started_at
    ).pipe(
      Effect.mapError((cause) => corruption(row.session_id, "Session started_at is corrupt", cause))
    )
    const lastActivity = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
      row.last_activity
    ).pipe(
      Effect.mapError((cause) =>
        corruption(row.session_id, "Session last_activity is corrupt", cause)
      )
    )
    const metadata = yield* decodeJson(JsonObjectSchema, row.metadata ?? "{}").pipe(
      Effect.mapError((cause) => corruption(row.session_id, "Session metadata is corrupt", cause))
    )
    const lastInputTokens = yield* Schema.decodeUnknownEffect(OptionalInputTokens)(
      metadata.last_input_tokens ?? null
    ).pipe(
      Effect.mapError((cause) =>
        corruption(row.session_id, "Session metadata.last_input_tokens is corrupt", cause)
      )
    )
    const jobs =
      row.origin_automation_id === null
        ? []
        : yield* sql<{
            readonly purpose: JobPurpose
          }>`SELECT purpose FROM scheduled_tasks WHERE task_id = ${row.origin_automation_id}`.pipe(
            Effect.mapError((cause) =>
              corruption(row.session_id, "Session job classification is unavailable", cause)
            )
          )
    const forkOrigin = sessionForkOriginFromMetadata(metadata, row.started_at)
    const header = yield* Schema.decodeUnknownEffect(SessionHistoryHeaderSchema)({
      originJobPurpose: jobs[0]?.purpose ?? null,
      sessionId: row.session_id,
      publicRef: row.public_ref,
      startedAt,
      lastActivity,
      name: row.name,
      sessionType: row.session_type ?? "chat",
      originAutomationId: row.origin_automation_id,
      parentSessionId: row.parent_session_id,
      parentRunId: row.parent_run_id,
      parentToolCallId: row.parent_tool_call_id,
      parentMessageId: row.parent_message_id,
      spaceId: row.space_id,
      chatModel: row.chat_model,
      activeMessageCount: row.active_message_count,
      lastInputTokens,
      contextGeneration: row.context_generation,
      ...(forkOrigin === undefined ? {} : { forkOrigin })
    }).pipe(
      Effect.mapError((cause) => corruption(row.session_id, "Session header is corrupt", cause))
    )
    return { header, metadata }
  })

  const messages = (sessionId: string) =>
    loadActiveContext(sql, sessionId).pipe(
      Effect.mapError((cause) =>
        cause instanceof ActiveContextError
          ? corruption(sessionId, cause.message, cause)
          : queryError("load", "Could not load the model context", cause)
      )
    )

  const load = (sessionId?: string) =>
    snapshot(
      Effect.gen(function* () {
        const rows = yield* find(sessionId).pipe(
          Effect.mapError((cause) => queryError("load", "Could not load session", cause))
        )
        const row = rows[0]
        if (row === undefined) return null
        const { header, metadata } = yield* headerSnapshot(row)
        const sessionMessages = yield* messages(row.session_id)
        return yield* Schema.decodeUnknownEffect(ActiveSessionSnapshotSchema)({
          header,
          messages: sessionMessages,
          metadata
        }).pipe(
          Effect.mapError((cause) =>
            corruption(row.session_id, "Session snapshot is corrupt", cause)
          )
        )
      })
    ).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(queryError("load", "Could not load session", cause))
      ),
      Effect.withSpan("SqliteSessionQueries.load")
    )

  const loadHeaderSnapshot = Effect.fn("SqliteSessionQueries.loadHeaderSnapshot")(function* (
    sessionId?: string
  ) {
    const rows = yield* find(sessionId).pipe(
      Effect.mapError((cause) =>
        queryError("history_header", "Could not load session history header", cause)
      )
    )
    const row = rows[0]
    return row === undefined ? null : yield* headerSnapshot(row)
  })

  const loadHistoryHeader = (sessionId?: string) =>
    loadHeaderSnapshot(sessionId).pipe(Effect.map((snapshot) => snapshot?.header ?? null))

  const listDirectAgentChildren = Effect.fn("SqliteSessionQueries.listDirectAgentChildren")(
    function* (sessionId: string) {
      const rows = yield* sql<{
        readonly session_id: string
        readonly public_ref: string
        readonly name: string | null
        readonly purpose: string | null
        readonly parent_run_id: string | null
        readonly parent_tool_call_id: string | null
      }>`
        SELECT child.session_id, child.public_ref, substr(child.name, 1, 120) AS name,
          substr(json_extract(spawn.arguments_json, '$.task'), 1, 241) AS purpose,
          child.parent_run_id, child.parent_tool_call_id
        FROM sessions AS child
        LEFT JOIN tool_calls AS spawn ON spawn.run_id = child.parent_run_id
          AND spawn.tool_call_id = child.parent_tool_call_id AND spawn.tool_name = 'spawn_agent'
        WHERE child.archived_at IS NULL
          AND child.session_type = 'agent'
          AND child.parent_session_id = ${sessionId}
        ORDER BY EXISTS (SELECT 1 FROM chat_runs AS run
          WHERE run.session_id = child.session_id AND run.status IN ${activeRunStatusList}) DESC,
          child.last_activity DESC, child.session_id DESC
        LIMIT 32
      `.pipe(
        Effect.mapError((cause) =>
          queryError("agent_children", "Could not load direct agent children", cause)
        )
      )
      return yield* Schema.decodeUnknownEffect(Schema.Array(AgentChildReferenceSchema))(
        rows.map((row) => ({
          sessionId: row.session_id,
          publicRef: row.public_ref,
          name: row.name,
          purpose: row.purpose === null ? null : cutText(row.purpose, 240),
          parentRunId: row.parent_run_id,
          parentToolCallId: row.parent_tool_call_id
        }))
      ).pipe(
        Effect.mapError((cause) =>
          corruption(sessionId, "Direct agent child identity is corrupt", cause)
        )
      )
    }
  )

  const nameSeed = (envelope: StoredMessageEnvelope): SessionNameSeed | null => {
    if (envelope.role !== "user" || envelope.is_meta === true) return null
    const content = envelope.content
    const blocks: ReadonlyArray<Readonly<Record<string, unknown>>> = Array.isArray(content)
      ? content.filter(
          (block): block is Readonly<Record<string, unknown>> =>
            typeof block === "object" && block !== null && !Array.isArray(block)
        )
      : []
    const text =
      typeof content === "string"
        ? content
        : blocks
            .flatMap((block) =>
              block.type === "text" && typeof block.text === "string" ? [block.text] : []
            )
            .join("\n")
    const images = blocks.flatMap((block): ReadonlyArray<SessionNameImage> =>
      block.type === "image" &&
      (block.media_type === "image/png" || block.media_type === "image/jpeg") &&
      typeof block.data === "string" &&
      block.data.length > 0
        ? [{ mediaType: block.media_type, data: block.data }]
        : []
    )
    const trimmed = text.trim()
    return trimmed.startsWith("/") || (trimmed.length === 0 && images.length === 0)
      ? null
      : { text, images }
  }

  const loadNameSeed = Effect.fn("SqliteSessionQueries.loadNameSeed")(function* (
    sessionId: string
  ) {
    const decodeCandidate = (value: string) =>
      decodeJson(StoredMessageEnvelopeSchema, value).pipe(
        Effect.mapError((cause) => corruption(sessionId, "Accepted Chat input is corrupt", cause)),
        Effect.map(nameSeed)
      )
    const pageSize = 64
    let offset = 0
    while (true) {
      const rows = yield* sql<{ readonly message_json: string }>`
        SELECT message_json
        FROM chat_idempotency_keys
        WHERE session_id = ${sessionId} AND message_json IS NOT NULL
        ORDER BY created_at ASC, rowid ASC
        LIMIT ${pageSize} OFFSET ${offset}
      `.pipe(
        Effect.mapError((cause) =>
          queryError("name_seed", "Could not load accepted Chat inputs", cause)
        )
      )
      for (const row of rows) {
        const candidate = yield* decodeCandidate(row.message_json)
        if (candidate !== null) return candidate
      }
      if (rows.length < pageSize) break
      offset += rows.length
    }

    const legacyRows = yield* sql<{ readonly message_json: string }>`
      SELECT message.message_json
      FROM session_messages AS message
      JOIN sessions AS session ON session.session_id = message.session_id
      WHERE message.session_id = ${sessionId}
        AND message.role = 'user'
        AND message.created_at >= session.started_at
      ORDER BY message.seq ASC
    `.pipe(
      Effect.mapError((cause) =>
        queryError("name_seed", "Could not load legacy Chat inputs", cause)
      )
    )
    for (const row of legacyRows) {
      const candidate = yield* decodeCandidate(row.message_json)
      if (candidate !== null) return candidate
    }
    return null
  })

  const blockingWork = Effect.fn("SqliteSessionQueries.blockingWork")(function* (
    sessionId: string
  ) {
    const rows = yield* sql<{ readonly blocking_work: number }>`
      SELECT ${sessionBlockingWorkPredicate(sql)} AS blocking_work
      FROM sessions AS s
      WHERE s.session_id = ${sessionId}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        queryError("blocking_work", "Could not load session work state", cause)
      )
    )
    return rows[0]?.blocking_work === 1
  })

  const browserScope = Effect.fn("SqliteSessionQueries.browserScope")(function* (
    input: BrowserScopeInput
  ): Effect.fn.Return<BrowserScopeSnapshot | undefined, SessionQueryError> {
    return yield* snapshot(
      Effect.gen(function* () {
        let scope: BrowserScope
        if (input.kind === "session") {
          const rows = yield* sql<{ readonly space_id: string | null }>`
          SELECT space_id FROM sessions WHERE session_id = ${input.sessionId}
        `
          const row = rows[0]
          if (row === undefined) return undefined
          scope =
            row.space_id === null ? { kind: "home" } : { kind: "space", spaceId: row.space_id }
        } else {
          scope = input
          if (scope.kind === "space") {
            const spaces = yield* sql<{
              readonly space_id: string
            }>`SELECT space_id FROM spaces WHERE space_id = ${scope.spaceId}`
            if (spaces.length === 0) return undefined
          }
        }
        const rows =
          scope.kind === "home"
            ? yield* sql<{
                readonly session_id: string
              }>`SELECT session_id FROM sessions WHERE space_id IS NULL ORDER BY session_id`
            : yield* sql<{
                readonly session_id: string
              }>`SELECT session_id FROM sessions WHERE space_id = ${scope.spaceId} ORDER BY session_id`
        const revisions = yield* sql<{ readonly revision: number }>`
          SELECT COALESCE(${journalHeadSequenceSql(sql, SESSION_LIFECYCLE_STREAM_ID)}, 0) AS revision
        `
        return {
          revision: revisions[0]?.revision ?? 0,
          scope,
          sessionIds: rows.map((row) => row.session_id)
        }
      })
    ).pipe(
      Effect.mapError((cause) =>
        queryError("browser_scope", "Could not read browser membership", cause)
      )
    )
  })

  const openSpaceChats = Effect.fn("SqliteSessionQueries.openSpaceChats")(function* (
    spaceId: string
  ) {
    return yield* sql<{ readonly sessionId: string; readonly name: string | null }>`
      SELECT session_id AS sessionId, name FROM sessions
      WHERE space_id = ${spaceId} AND archived_at IS NULL AND session_type <> 'agent'
      ORDER BY started_at, session_id
    `.pipe(
      Effect.mapError((cause) =>
        queryError("space_chats", "Could not read the Space's chats", cause)
      )
    )
  })

  const sessionIdForRef = Effect.fn("SqliteSessionQueries.sessionIdForRef")(function* (
    publicRef: string
  ) {
    const rows = yield* sql<{ readonly session_id: string }>`
      SELECT session_id FROM sessions WHERE public_ref = ${publicRef} LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        queryError("session_ref", "Could not resolve a chat reference", cause)
      )
    )
    return rows[0]?.session_id ?? null
  })

  const loadCapture = (sessionId: string) =>
    loadHeaderSnapshot(sessionId).pipe(
      Effect.map((snapshot) => (snapshot === null ? undefined : readCapture(snapshot.metadata)))
    )

  const readToolEvidence: SessionQueries["Service"]["readToolEvidence"] = (input) =>
    readSessionToolEvidence(sql, input).pipe(
      Effect.mapError((cause) =>
        queryError("tool_evidence", "Could not read durable tool evidence", cause)
      )
    )

  return SessionQueries.of({
    readToolEvidence,
    load,
    loadHeaderSnapshot,
    loadCapture,
    loadHistoryHeader,
    sessionIdForRef,
    listDirectAgentChildren,
    loadNameSeed,
    blockingWork,
    openSpaceChats,
    browserScope
  })
}
