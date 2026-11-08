import { latestSessionRunQuery } from "./session-latest-run.js"
import { sessionOriginQuery } from "./session-origin.js"
import { sessionPresentations } from "./session-presentation.js"
import { withFileNames } from "@arden-hq/protocol/chat"
import { previewLine } from "../transcript/preview-line.js"
import type { SessionPresentation } from "@arden-hq/protocol"
import { Effect, Schema } from "effect"
import { journalHeadSequenceSql } from "@arden-hq/journal/effect"
import type { SessionType } from "@arden-hq/protocol/sessions"
import {
  IsoDateTimeStringSchema,
  RuntimeRunStatusSchema,
  SessionTypeSchema
} from "@arden-hq/protocol/effect/common"
import type {
  ArchivedSessionEntry,
  SessionListEntry,
  SessionListQuery,
  SessionStore,
  SessionStoreError,
  StoredSession
} from "../sessions/store.js"
import type { PersistenceDeps } from "./deps.js"
import { storeError } from "./session-rows.js"
import { decodeJsonWith } from "./json.js"
import { StoredTriageSchema } from "../sessions/triage.js"
import { StoredForkSchema } from "../sessions/fork.js"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import { activeRunStatusList } from "./status-sets.js"
import { JsonObjectSchema } from "../json.js"
import { sessionForkOriginFromMetadata } from "../sessions/fork-origin.js"
import { pendingDecisionCards } from "./pending-decision-cards.js"

const sessionListOptionsSchema = Schema.Struct({
  spaceId: Schema.optionalKey(Schema.NonEmptyString),
  inbox: Schema.optionalKey(Schema.Boolean),
  scope: Schema.optionalKey(Schema.Literals(["primary", "agent", "all"] as const)),
  live: Schema.optionalKey(Schema.Boolean),
  parentSessionIds: Schema.optionalKey(
    Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(100))
  ),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 501 }))),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  sort: Schema.optionalKey(Schema.Literals(["activity", "accessed"] as const)),
  cursor: Schema.optionalKey(
    Schema.Struct({
      at: Schema.String,
      sessionId: Schema.NonEmptyString
    })
  ),
  sessionRef: Schema.optionalKey(Schema.NonEmptyString),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  sessionIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(100)))
}).check(
  Schema.makeFilter((options) =>
    options.cursor === undefined || options.offset === undefined
      ? undefined
      : "session-list cursor and offset are mutually exclusive"
  )
)

const nullableText = Schema.NullOr(Schema.String)
const nullableId = Schema.NullOr(Schema.NonEmptyString)
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const storedSessionColumns = {
  session_id: Schema.NonEmptyString,
  public_ref: Schema.String,
  started_at: IsoDateTimeStringSchema,
  last_activity: IsoDateTimeStringSchema,
  last_accessed_at: Schema.NullOr(IsoDateTimeStringSchema),
  name: nullableText,
  message_count: count,
  space_id: nullableText,
  chat_model: nullableText,
  origin_automation_id: nullableText,
  parent_session_id: nullableText,
  parent_run_id: nullableText,
  parent_tool_call_id: nullableText,
  parent_message_id: nullableText
}

const StoredSessionColumnsSchema = Schema.Struct(storedSessionColumns)

const SessionListRowSchema = Schema.Struct({
  agent_workspace: nullableText,
  ...storedSessionColumns,
  session_type: Schema.NullOr(SessionTypeSchema),
  space_name: nullableText,
  archived_at: Schema.NullOr(IsoDateTimeStringSchema),
  has_unread: Schema.Number,
  latest_event_seq: count,
  checkpoint_seq: count,
  run_id: nullableId,
  run_turn_id: nullableText,
  run_status: Schema.NullOr(RuntimeRunStatusSchema),
  run_error_code: nullableText,
  run_stop_reason: nullableText,
  pending_approvals_count: count,
  pending_connections_count: count,
  triage_json: Schema.NullOr(Schema.String),
  fork_json: Schema.NullOr(Schema.String),
  fork_metadata_json: Schema.String,
  thread_source_id: Schema.NullOr(Schema.String),
  thread_source_ref: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.Literals(["capture", "onboarding"]))
})

const ArchivedSessionRowSchema = Schema.Struct({
  ...storedSessionColumns,
  session_type: SessionTypeSchema,
  archived_at: IsoDateTimeStringSchema,
  first_text: Schema.NullOr(Schema.String)
})

type SessionListRow = (typeof SessionListRowSchema)["Encoded"]
type ArchivedSessionRow = (typeof ArchivedSessionRowSchema)["Encoded"]

const storedSession = (
  row: (typeof StoredSessionColumnsSchema)["Type"],
  sessionType: SessionType
): StoredSession => ({
  sessionId: row.session_id,
  publicRef: row.public_ref,
  startedAt: row.started_at,
  lastActivity: row.last_activity,
  lastAccessedAt: row.last_accessed_at ?? undefined,
  name: row.name ?? undefined,
  messageCount: row.message_count,
  spaceId: row.space_id ?? undefined,
  chatModel: row.chat_model ?? undefined,
  sessionType,
  originAutomationId: row.origin_automation_id ?? undefined,
  parentSessionId: row.parent_session_id ?? undefined,
  parentRunId: row.parent_run_id ?? undefined,
  parentToolCallId: row.parent_tool_call_id ?? undefined,
  parentMessageId: row.parent_message_id ?? undefined
})

const listItem = Effect.fn("SqliteSessionStore.listItem")(function* (
  raw: SessionListRow,
  presentation: SessionPresentation
): Effect.fn.Return<SessionListEntry, SessionStoreError> {
  const row = yield* Schema.decodeUnknownEffect(SessionListRowSchema)(raw).pipe(
    Effect.mapError((cause) =>
      storeError("list", "storage", "Stored session list row is corrupt", raw.session_id, cause)
    )
  )
  if (row.run_id !== null && !row.run_turn_id) {
    return yield* storeError(
      "list",
      "storage",
      "Stored Chat run has no durable turn id",
      row.session_id
    )
  }
  const triage =
    row.triage_json === null
      ? undefined
      : yield* decodeJsonWith(StoredTriageSchema, row.triage_json, (cause) =>
          storeError("list", "storage", "Stored triage decision is corrupt", row.session_id, cause)
        )
  const fork =
    row.fork_json === null
      ? undefined
      : yield* decodeJsonWith(StoredForkSchema, row.fork_json, (cause) =>
          storeError("list", "storage", "Stored fork origin is corrupt", row.session_id, cause)
        )
  const forkMetadata = yield* decodeJsonWith(JsonObjectSchema, row.fork_metadata_json, (cause) =>
    storeError("list", "storage", "Stored session metadata is corrupt", row.session_id, cause)
  )
  const forkOrigin = sessionForkOriginFromMetadata(forkMetadata, row.started_at)
  const runStatus = row.run_status
  return {
    ...storedSession(row, row.session_type ?? "chat"),
    presentation,
    spaceName: row.space_name ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    hasUnread: row.has_unread !== 0,
    latestRun:
      runStatus === null
        ? undefined
        : {
            status: runStatus,
            errorCode: row.run_error_code ?? undefined,
            stopReason: row.run_stop_reason ?? undefined
          },
    activeRun:
      row.run_id !== null && row.run_turn_id && runStatus !== null && isActiveRunStatus(runStatus)
        ? { runId: row.run_id, turnId: row.run_turn_id }
        : undefined,
    checkpointSeq: row.checkpoint_seq,
    latestEventSeq: row.latest_event_seq,
    pendingApprovalsCount: row.pending_approvals_count,
    pendingConnectionsCount: row.pending_connections_count,
    triage,
    fork,
    forkOrigin,
    threadSource:
      row.thread_source_id === null
        ? undefined
        : { sessionId: row.thread_source_id, sessionRef: row.thread_source_ref },
    summary: row.summary ?? undefined,
    agentWorkspace: row.agent_workspace ?? undefined,
    latestRunId: row.run_id ?? undefined,
    origin: row.origin ?? undefined
  }
})

const archivedListItem = Effect.fn("SqliteSessionStore.archivedListItem")(function* (
  raw: ArchivedSessionRow
): Effect.fn.Return<ArchivedSessionEntry, SessionStoreError> {
  const row = yield* Schema.decodeUnknownEffect(ArchivedSessionRowSchema)(raw).pipe(
    Effect.mapError((cause) =>
      storeError(
        "list_archived",
        "storage",
        "Stored archived session row is corrupt",
        raw.session_id,
        cause
      )
    )
  )
  return {
    ...storedSession(row, row.session_type),
    archivedAt: row.archived_at,
    firstLine: previewLine(row.first_text === null ? null : withFileNames(row.first_text))
  }
})

export const makeSessionListing = ({
  reader,
  chatEvents
}: Pick<PersistenceDeps, "reader" | "chatEvents">): Pick<
  SessionStore["Service"],
  "list" | "listArchived"
> => {
  const list = Effect.fn("SqliteSessionStore.list")(function* (query?: SessionListQuery) {
    const input = yield* Schema.decodeUnknownEffect(sessionListOptionsSchema)(query ?? {}).pipe(
      Effect.mapError((cause) =>
        storeError("list", "invalid", "Invalid session-list options", undefined, cause)
      )
    )
    const limit = input.limit ?? 100
    const offset = input.offset ?? 0
    const sort = input.sort ?? "activity"
    let spaceFilter = reader``
    if (input.inbox === true) spaceFilter = reader`AND s.space_id IS NULL`
    else if (input.spaceId !== undefined) spaceFilter = reader`AND s.space_id = ${input.spaceId}`
    let agentFilter = reader``
    if (input.scope === "primary")
      agentFilter = reader`AND s.session_type = 'chat'
      AND s.parent_session_id IS NULL AND s.parent_message_id IS NULL`
    else if (input.scope === "agent") agentFilter = reader`AND s.session_type = 'agent'`
    const liveFilter =
      input.live === true ? reader`AND latest_run.status IN ${activeRunStatusList}` : reader``
    const parentFilter =
      input.parentSessionIds === undefined || input.parentSessionIds.length === 0
        ? reader``
        : reader`AND s.parent_session_id IN ${reader.in(input.parentSessionIds)}`
    const archivedFilter =
      input.includeArchived === true ? reader`1 = 1` : reader`s.archived_at IS NULL`
    const refFilter =
      input.sessionRef === undefined ? reader`` : reader`AND s.public_ref = ${input.sessionRef}`
    const sessionIdFilter =
      input.sessionIds === undefined || input.sessionIds.length === 0
        ? reader``
        : reader`AND s.session_id IN ${reader.in(input.sessionIds)}`
    const orderTimestamp =
      sort === "accessed"
        ? reader`COALESCE(s.last_accessed_at, s.last_activity)`
        : reader`s.last_activity`
    const cursorFilter =
      input.cursor === undefined
        ? reader``
        : reader`AND (
          ${orderTimestamp} < ${input.cursor.at}
          OR (${orderTimestamp} = ${input.cursor.at} AND s.session_id < ${input.cursor.sessionId})
        )`
    const rows = yield* reader<SessionListRow>`
      SELECT s.session_id, s.public_ref, s.started_at, s.last_activity,
             s.last_accessed_at, s.name,
             s.visible_message_count AS message_count, s.space_id, s.chat_model,
             s.session_type, s.origin_automation_id, s.parent_session_id,
             s.parent_run_id, s.parent_tool_call_id, s.parent_message_id,
             s.has_unread, s.archived_at,
             (SELECT name FROM spaces WHERE space_id = s.space_id) AS space_name,
             COALESCE(${journalHeadSequenceSql(reader, reader.literal("s.session_id"))}, 0) AS latest_event_seq,
             COALESCE((
               SELECT checkpoint_seq FROM session_event_checkpoints
               WHERE session_id = s.session_id
             ), 0) AS checkpoint_seq,
             latest_run.run_id AS run_id,
             json_extract(latest_run.metadata_json, '$.turn_id') AS run_turn_id,
             latest_run.status AS run_status,
             latest_run.error_code AS run_error_code,
             latest_run.stop_reason AS run_stop_reason,
             (
               SELECT COUNT(*) FROM (${pendingDecisionCards(reader)}) AS pending_approval
             WHERE pending_approval.session_id = s.session_id
               AND COALESCE(
                 json_extract(pending_approval.payload_json, '$.approval_data._tag'),
                 ''
               ) != 'ConnectionRequired'
             ) AS pending_approvals_count,
             (
               SELECT COUNT(*) FROM (${pendingDecisionCards(reader)}) AS pending_connection
               WHERE pending_connection.session_id = s.session_id
                 AND json_extract(
                   pending_connection.payload_json,
                   '$.approval_data._tag'
                 ) = 'ConnectionRequired'
             ) AS pending_connections_count,
             json_extract(s.metadata, '$.triage') AS triage_json,
             json_extract(s.metadata, '$.fork') AS fork_json,
             json_object('fork_origin', json_extract(s.metadata, '$.fork_origin'),
               'fork_of', json_extract(s.metadata, '$.fork_of')) AS fork_metadata_json,
             json_extract(s.metadata, '$.thread.source_session_id') AS thread_source_id,
             (SELECT source.public_ref FROM sessions AS source
               WHERE source.session_id = json_extract(s.metadata, '$.thread.source_session_id')
             ) AS thread_source_ref,
             (SELECT summary FROM chat_summaries WHERE session_id = s.session_id) AS summary,
             CASE WHEN s.session_type = 'agent' AND json_extract(s.metadata, '$.agent.mode') = 'code'
               THEN json_extract(s.metadata, '$.agent.workspace.cwd') END AS agent_workspace,
             ${reader.literal(sessionOriginQuery)} AS origin
      FROM sessions AS s
      LEFT JOIN chat_runs AS latest_run
        ON latest_run.run_id = (${reader.literal(latestSessionRunQuery)})
      WHERE ${archivedFilter}
        ${spaceFilter}
        ${agentFilter}
        ${liveFilter}
        ${parentFilter}
        ${sessionIdFilter}
        ${refFilter}
        ${cursorFilter}
      ORDER BY ${orderTimestamp} DESC, s.session_id DESC
      LIMIT ${limit} OFFSET ${offset}
    `.pipe(
      Effect.mapError((cause) =>
        storeError("list", "storage", "Could not list sessions", undefined, cause)
      )
    )
    const presentations = yield* sessionPresentations(
      reader,
      rows.map((row) => row.session_id)
    ).pipe(
      Effect.mapError((cause) =>
        storeError("list", "storage", "Could not classify Sessions", undefined, cause)
      )
    )
    return yield* Effect.forEach(rows, (row) => {
      const presentation = presentations.get(row.session_id)
      return presentation === undefined
        ? storeError("list", "storage", "Session presentation is missing", row.session_id)
        : listItem(row, presentation).pipe(
            Effect.map((item) => ({
              ...item,
              ...(item.activeRun === undefined
                ? {}
                : {
                    currentActivity: chatEvents.currentActivity(
                      item.sessionId,
                      item.activeRun.runId
                    )
                  })
            }))
          )
    })
  })

  const listArchived = Effect.fn("SqliteSessionStore.listArchived")(function* () {
    const rows = yield* reader<ArchivedSessionRow>`
      SELECT session_id, public_ref, started_at, last_activity, last_accessed_at,
             name, archived_at, visible_message_count AS message_count,
             space_id, chat_model, session_type, origin_automation_id,
             parent_session_id, parent_run_id, parent_tool_call_id,
             parent_message_id,
             (SELECT message.search_text FROM session_messages AS message
              WHERE message.session_id = sessions.session_id AND message.role = 'user'
                AND TRIM(COALESCE(message.search_text, '')) <> ''
              ORDER BY message.seq LIMIT 1) AS first_text
      FROM sessions
      WHERE archived_at IS NOT NULL
      ORDER BY archived_at DESC, session_id DESC
    `.pipe(
      Effect.mapError((cause) =>
        storeError("list_archived", "storage", "Could not list archived sessions", undefined, cause)
      )
    )
    return yield* Effect.forEach(rows, archivedListItem)
  })

  return { list, listArchived }
}
