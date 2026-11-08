import type { RunOrigin } from "@arden-hq/protocol/runs"
import { Effect, Schema } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { readAgentSessionMetadata } from "../../sessions/agent-mode.js"
import { decodeJson } from "./json.js"
import { scriptOwnsRun } from "./run-owner.js"
import { taskConversationSql } from "./task-conversation.js"

export interface RunColumns {
  readonly runId: Statement.Fragment
  readonly sessionId: Statement.Fragment
  readonly metadata: Statement.Fragment
}

export const runColumns = (
  sql: SqlClient.SqlClient,
  alias: string
): RunColumns & { readonly status: Statement.Fragment } => ({
  runId: sql`${sql(alias)}.run_id`,
  sessionId: sql`${sql(alias)}.session_id`,
  status: sql`${sql(alias)}.status`,
  metadata: sql`${sql(alias)}.metadata_json`
})

export const runDestinationSessionId = (sql: SqlClient.SqlClient, run: RunColumns) => {
  const owner = sql`COALESCE(json_extract(${run.metadata}, '$.run_context.belongs_to'),
    json_extract(${run.metadata}, '$.run_context.origin'))`
  const origin = (field: string) => sql`json_extract(${owner}, ${sql.literal(`'$.${field}'`)})`
  return sql`CASE ${origin("kind")}
  WHEN 'chat' THEN ${origin("session_id")}
  WHEN 'automation' THEN (
    SELECT task.thread_id FROM scheduled_tasks AS task
    WHERE task.task_id = ${origin("automation_id")}
  )
  WHEN 'task' THEN COALESCE(${taskConversationSql(sql, origin("item_id"))}, ${run.sessionId})
  WHEN 'space' THEN (
    SELECT conversation.session_id FROM space_conversations AS conversation
    WHERE conversation.space_id = ${origin("space_id")}
  )
  WHEN 'unrecorded' THEN ${run.sessionId}
END`
}

export interface DestinationRow {
  readonly session_id: string
  readonly public_ref: string
  readonly name: string | null
  readonly space_id: string | null
}

interface PlacedRun {
  readonly runId: string
  readonly sessionId: string | null
  readonly origin: RunOrigin
  readonly belongsTo?: RunOrigin | undefined
}

const readDestinationSessionId = Effect.fn("RunDestination.readSession")(function* (
  sql: SqlClient.SqlClient,
  run: PlacedRun
) {
  const context = {
    origin: run.origin,
    ...(run.belongsTo === undefined ? {} : { belongs_to: run.belongsTo })
  }
  const placed = yield* sql<{
    readonly session_id: string | null
  }>`SELECT ${runDestinationSessionId(sql, {
    runId: sql`${run.runId}`,
    sessionId: sql`${run.sessionId}`,
    metadata: sql`json(${JSON.stringify({ run_context: context })})`
  })} AS session_id`
  return placed[0]?.session_id ?? undefined
})

export type ChatPlace = {
  readonly sessionId: string
  readonly kind: "chat"
  readonly row: DestinationRow
}

export type Place =
  | ChatPlace
  | {
      readonly sessionId: string
      readonly kind: "own" | "parent" | "sender"
      readonly row: undefined
    }
  | { readonly sessionId: string | undefined; readonly kind: "gone"; readonly row: undefined }

const gone: Place = { sessionId: undefined, kind: "gone", row: undefined }

export const chatRow = Effect.fn("RunDestination.chatRow")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const rows = yield* sql<DestinationRow>`SELECT session.session_id, session.public_ref,
      session.name, session.space_id
    FROM sessions AS session
    LEFT JOIN spaces AS space ON space.space_id = session.space_id
    WHERE session.session_id = ${sessionId} AND session.archived_at IS NULL
      AND session.session_type IN ('chat', 'channel')
      AND (session.space_id IS NULL OR space.archived_at IS NULL)`
  return rows[0]
})

const chatPlace = Effect.fn("RunDestination.chatPlace")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
): Effect.fn.Return<Place, SqlError> {
  const row = yield* chatRow(sql, sessionId)
  return row === undefined
    ? { sessionId, kind: "gone", row: undefined }
    : { sessionId, kind: "chat", row }
})

export interface ChildAgent {
  readonly mode: "code" | "research" | "work"
  readonly parent: string
}

const readAgentChild = Effect.fn("RunDestination.agentChild")(function* (
  sql: SqlClient.SqlClient,
  run: { readonly runId: string; readonly sessionId: string }
) {
  const rows = yield* sql<{
    readonly session_type: string
    readonly parent_session_id: string | null
    readonly metadata: string | null
  }>`SELECT session_type, parent_session_id, metadata FROM sessions
    WHERE session_id = ${run.sessionId}`
  const child = rows[0]
  if (child?.session_type !== "agent" || child.parent_session_id === null) return undefined
  if (yield* scriptOwnsRun(sql, run.runId)) return undefined
  const agent = readAgentSessionMetadata(
    yield* decodeJson(Schema.Record(Schema.String, Schema.Json), child.metadata ?? "{}").pipe(
      Effect.orElseSucceed(() => ({}))
    )
  )
  return { mode: agent?.mode ?? "work", parent: child.parent_session_id } satisfies ChildAgent
})

export const placeOf = Effect.fn("RunDestination.placeOf")(function* (
  sql: SqlClient.SqlClient,
  run: {
    readonly runId: string
    readonly sessionId: string
    readonly origin: RunOrigin | undefined
    readonly belongsTo: RunOrigin | undefined
  }
): Effect.fn.Return<{ readonly place: Place; readonly agent: ChildAgent | undefined }, SqlError> {
  const { origin } = run
  const agent =
    origin === undefined || origin.kind === "chat" ? yield* readAgentChild(sql, run) : undefined
  if (agent !== undefined) {
    const parent =
      origin === undefined
        ? agent.parent
        : yield* readDestinationSessionId(sql, {
            runId: run.runId,
            sessionId: run.sessionId,
            origin
          })
    const place: Place =
      parent === undefined ? gone : { sessionId: parent, kind: "parent", row: undefined }
    return { place, agent }
  }
  if (origin === undefined)
    return { place: { sessionId: run.sessionId, kind: "own", row: undefined }, agent }
  const sessionId = yield* readDestinationSessionId(sql, { ...run, origin })
  if (sessionId === undefined) return { place: gone, agent }
  if (origin.kind === "chat" && origin.session_id !== run.sessionId)
    return { place: { sessionId, kind: "sender", row: undefined }, agent }
  if (sessionId === run.sessionId)
    return { place: { sessionId, kind: "own", row: undefined }, agent }
  return { place: yield* chatPlace(sql, sessionId), agent }
})

export type Entity =
  | { readonly kind: "task"; readonly itemId: string }
  | {
      readonly kind: "automation"
      readonly automationId: string
      readonly ownChats: boolean
    }

export const entityPlaces = Effect.fn("RunDestination.entityPlaces")(function* (
  sql: SqlClient.SqlClient,
  entity: Entity
): Effect.fn.Return<ReadonlyArray<Place>, SqlError> {
  const primary = yield* readDestinationSessionId(sql, {
    runId: "",
    sessionId: null,
    origin:
      entity.kind === "task"
        ? { kind: "task", item_id: entity.itemId, occurrence_id: "" }
        : { kind: "automation", automation_id: entity.automationId, occurrence_id: "" }
  })
  const sessionIds = [...(primary === undefined ? [] : [primary])]
  if (entity.kind === "automation" && entity.ownChats) {
    const own = yield* sql<{ readonly session_id: string }>`SELECT session_id FROM sessions
      WHERE session_type = 'channel' AND origin_automation_id = ${entity.automationId}
      ORDER BY session_id`
    sessionIds.push(...own.map((row) => row.session_id).filter((id) => id !== primary))
  }
  if (sessionIds.length === 0) return [gone]
  return yield* Effect.forEach(sessionIds, (sessionId) => chatPlace(sql, sessionId))
})
