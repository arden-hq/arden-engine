import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Reactivity } from "effect/unstable/reactivity"
import { makeSqliteThreadClient } from "@arden-hq/sqlite-thread"

import { deleteSessionTree, sessionDeletionTree } from "./session-tree-deletion.js"
import { sessionActiveWorkSql } from "./work-retention.js"
import { BREAKDOWN_QUERIES, type BreakdownRows } from "./storage-breakdown-queries.js"
import {
  StorageSessionStore,
  StorageSessionStoreError,
  type StorageSessionCandidate,
  type StorageSessionProtection
} from "../storage/session-store.js"
import type { PersistenceDeps } from "./deps.js"
import { taskUnfinishedSql } from "./task-status-sql.js"
import { userChatSql } from "./chat-ownership.js"

interface CandidateRow {
  readonly session_id: string
  readonly name: string | null
  readonly archived: number
  readonly last_activity: string
  readonly tree_bytes: number
  readonly tree_agents: number
  readonly tree_side_chats: number
  readonly tree_session_ids: string
  readonly has_active_work: number
  readonly has_automation_or_task: number
  readonly has_space: number
  readonly has_linked_session: number
  readonly has_unfinished_todo: number
}

type CandidateScope =
  | { readonly kind: "all" }
  | { readonly kind: "chat"; readonly sessionId: string }

const storeError = (
  operation: StorageSessionStoreError["operation"],
  reason: StorageSessionStoreError["reason"],
  message: string,
  sessionId?: string,
  cause?: unknown
): StorageSessionStoreError =>
  new StorageSessionStoreError({
    operation,
    reason,
    message,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(cause === undefined ? {} : { cause })
  })

const sessionOwnBytesSql = (sql: SqlClient.SqlClient, alias: string) => {
  const session = sql.literal(alias)
  return sql`MAX(1,
    COALESCE(octet_length(${session}.messages), 0)
    + COALESCE(octet_length(${session}.metadata), 0)
    + COALESCE(octet_length(${session}.name), 0)
    + COALESCE((
        SELECT sum(
          octet_length(message.message_json)
          + COALESCE(octet_length(message.search_text), 0)
        )
        FROM session_messages AS message
        WHERE message.session_id = ${session}.session_id
      ), 0)
    + COALESCE((
        SELECT sum(COALESCE(octet_length(run.metadata_json), 0)
          + COALESCE(octet_length(run.error_message), 0))
        FROM chat_runs AS run
        WHERE run.session_id = ${session}.session_id
      ), 0))`
}

const loadTotalBytes = (sql: SqlClient.SqlClient) => sql<{ readonly total: number }>`
  SELECT COALESCE(SUM(${sessionOwnBytesSql(sql, "s")}), 0) AS total FROM sessions AS s`

const loadRows = (sql: SqlClient.SqlClient, scope: CandidateScope) => sql<CandidateRow>`
  WITH RECURSIVE ${sessionDeletionTree(sql, {
    name: "deletion_tree",
    from: sql`SELECT session_id FROM sessions
      WHERE ${userChatSql()} AND parent_session_id IS NULL
        ${scope.kind === "chat" ? sql`AND session_id = ${scope.sessionId}` : sql``}`,
    root: true
  })},
  members(root_session_id, session_id) AS MATERIALIZED (
    SELECT DISTINCT root_session_id, session_id FROM deletion_tree
  ),
  own(session_id, session_type, last_activity, logical_bytes, has_active_work,
      has_automation_or_task) AS MATERIALIZED (
    SELECT s.session_id, s.session_type,
           COALESCE(s.last_accessed_at, s.last_activity),
           ${sessionOwnBytesSql(sql, "s")},
           CASE WHEN ${sessionActiveWorkSql(sql, "s")} THEN 1 ELSE 0 END,
           CASE WHEN
             EXISTS (
               SELECT 1 FROM scheduled_tasks AS task
               WHERE task.thread_id = s.session_id
             ) OR EXISTS (
               SELECT 1 FROM automation_runs AS run
               WHERE run.chat_session_id = s.session_id
             ) OR EXISTS (
               SELECT 1 FROM space_tasks AS home_task
               WHERE home_task.home_session_id = s.session_id
                 AND ${taskUnfinishedSql("home_task")}
             ) THEN 1 ELSE 0 END
    FROM sessions AS s
    WHERE s.session_id IN (SELECT session_id FROM members)
  ),
  tree AS MATERIALIZED (
    SELECT member.root_session_id AS session_id,
           SUM(own.logical_bytes) AS bytes,
           SUM(member.session_id <> member.root_session_id
             AND own.session_type = 'agent') AS agents,
           SUM(member.session_id <> member.root_session_id
             AND own.session_type <> 'agent') AS side_chats,
           json_group_array(member.session_id)
             FILTER (WHERE member.session_id <> member.root_session_id) AS session_ids,
           MAX(own.last_activity) AS last_activity,
           MAX(own.has_active_work) AS has_active_work,
           MAX(own.has_automation_or_task) AS has_automation_or_task,
           MAX(EXISTS (
             SELECT 1 FROM sessions AS child
             WHERE child.parent_session_id = member.session_id
               AND NOT EXISTS (
                 SELECT 1 FROM members AS kept
                 WHERE kept.root_session_id = member.root_session_id
                   AND kept.session_id = child.session_id
               )
           )) AS has_linked_session
    FROM members AS member
    JOIN own ON own.session_id = member.session_id
    GROUP BY member.root_session_id
  )
  SELECT s.session_id, s.name,
         CASE WHEN s.archived_at IS NULL THEN 0 ELSE 1 END AS archived,
         tree.last_activity,
         tree.bytes AS tree_bytes,
         tree.agents AS tree_agents,
         tree.side_chats AS tree_side_chats,
         tree.session_ids AS tree_session_ids,
         tree.has_active_work,
         tree.has_automation_or_task,
         CASE WHEN s.space_id IS NULL THEN 0 ELSE 1 END AS has_space,
         tree.has_linked_session,
         CASE WHEN EXISTS (
           SELECT 1
           FROM session_todos AS todo, json_each(todo.items_json) AS item
           WHERE todo.session_id = s.session_id
             AND json_extract(item.value, '$.status') IN ('pending', 'in_progress')
         ) THEN 1 ELSE 0 END AS has_unfinished_todo
  FROM sessions AS s
  JOIN tree ON tree.session_id = s.session_id
  ORDER BY COALESCE(s.last_accessed_at, s.last_activity), s.session_id
`

const binaryFlag = (value: number, name: string, sessionId: string): boolean => {
  if (value === 0) return false
  if (value === 1) return true
  throw storeError(
    "candidates",
    "storage",
    `Stored Session cleanup flag ${name} is corrupt`,
    sessionId
  )
}

const treeSessionIds = (row: CandidateRow): ReadonlyArray<string> => {
  const ids: unknown = JSON.parse(row.tree_session_ids)
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    throw storeError("candidates", "storage", "Stored Session tree is corrupt", row.session_id)
  }
  return ids.toSorted()
}

const candidateFromRow = (row: CandidateRow): StorageSessionCandidate => {
  const protections: Array<StorageSessionProtection> = []
  if (binaryFlag(row.has_active_work, "active_work", row.session_id)) {
    protections.push("active_work")
  }
  if (binaryFlag(row.has_automation_or_task, "automation_or_task", row.session_id)) {
    protections.push("automation_or_task")
  }
  if (binaryFlag(row.has_space, "space_owned", row.session_id)) {
    protections.push("space_owned")
  }
  if (binaryFlag(row.has_linked_session, "linked_session", row.session_id)) {
    protections.push("linked_session")
  }
  if (binaryFlag(row.has_unfinished_todo, "unfinished_todo", row.session_id)) {
    protections.push("unfinished_todo")
  }
  return {
    sessionId: row.session_id,
    name: row.name?.trim() || "Untitled Chat",
    archived: binaryFlag(row.archived, "archived", row.session_id),
    lastActivity: row.last_activity,
    sizeBytes: row.tree_bytes,
    deletesWith: {
      agents: row.tree_agents,
      sideChats: row.tree_side_chats,
      sessionIds: treeSessionIds(row)
    },
    protections
  }
}

const sameCandidate = (left: StorageSessionCandidate, right: StorageSessionCandidate): boolean =>
  left.sessionId === right.sessionId &&
  left.name === right.name &&
  left.archived === right.archived &&
  left.lastActivity === right.lastActivity &&
  left.sizeBytes === right.sizeBytes &&
  left.deletesWith.agents === right.deletesWith.agents &&
  left.deletesWith.sideChats === right.deletesWith.sideChats &&
  left.deletesWith.sessionIds.join("\n") === right.deletesWith.sessionIds.join("\n") &&
  left.protections.length === right.protections.length &&
  left.protections.every((protection, index) => protection === right.protections[index])

const readBreakdown = (sql: SqlClient.SqlClient) =>
  sql.withTransaction(
    Effect.all({
      others: sql.unsafe<BreakdownRows["others"][number]>(BREAKDOWN_QUERIES.others),
      size: sql.unsafe<BreakdownRows["size"][number]>(BREAKDOWN_QUERIES.size),
      weights: sql.unsafe<BreakdownRows["weights"][number]>(BREAKDOWN_QUERIES.weights),
      counts: sql.unsafe<BreakdownRows["counts"][number]>(BREAKDOWN_QUERIES.counts)
    })
  )

const measureOnOwnConnection = (filename: string) =>
  Effect.scoped(
    Effect.flatMap(makeSqliteThreadClient({ filename, readonly: true }), readBreakdown)
  ).pipe(Effect.provide(Reactivity.layer))

export const makeStorageSessionStore = (
  { writer, sessionEvents }: Pick<PersistenceDeps, "writer" | "sessionEvents">,
  filename: string
): StorageSessionStore["Service"] => {
  const sql = writer.sql
  const candidates = Effect.fn("SqliteStorageSessionStore.candidates")(function* () {
    const { rows, totals } = yield* writer
      .snapshot(
        Effect.all({
          rows: loadRows(writer.reader, { kind: "all" }),
          totals: loadTotalBytes(writer.reader)
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          storeError(
            "candidates",
            "storage",
            "Could not inspect Sessions for Storage cleanup",
            undefined,
            cause
          )
        )
      )
    const totalLogicalBytes = totals[0]?.total
    if (
      totalLogicalBytes === undefined ||
      !Number.isSafeInteger(totalLogicalBytes) ||
      totalLogicalBytes < 0
    ) {
      return yield* storeError("candidates", "storage", "Stored Session size total is invalid")
    }
    return { candidates: rows.map(candidateFromRow), totalLogicalBytes }
  })

  const deleteCandidate = Effect.fn("SqliteStorageSessionStore.deleteCandidate")(function* (
    expected: StorageSessionCandidate
  ) {
    yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* loadRows(sql, {
            kind: "chat",
            sessionId: expected.sessionId
          }).pipe(
            Effect.mapError((cause) =>
              storeError(
                "delete",
                "storage",
                "Could not revalidate the Session cleanup action",
                expected.sessionId,
                cause
              )
            )
          )
          const actualRow = rows[0]
          const actual = actualRow === undefined ? undefined : candidateFromRow(actualRow)
          if (
            actual === undefined ||
            !sameCandidate(actual, expected) ||
            actual.protections.length > 0
          ) {
            return yield* storeError(
              "delete",
              "conflict",
              "This chat changed. Preview the cleanup again.",
              expected.sessionId
            )
          }

          const deleted = yield* deleteSessionTree(
            sql,
            sessionEvents,
            sql`session_id = ${expected.sessionId}`
          ).pipe(
            Effect.mapError((cause) =>
              storeError("delete", "storage", "Could not delete Session", expected.sessionId, cause)
            )
          )
          if (deleted.kind !== "deleted") {
            return yield* storeError(
              "delete",
              "conflict",
              "This chat changed. Preview the cleanup again.",
              expected.sessionId
            )
          }
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof StorageSessionStoreError
            ? cause
            : storeError(
                "delete",
                "storage",
                "Could not permanently delete the Session",
                expected.sessionId,
                cause
              )
        )
      )
  })

  const compact = Effect.fn("SqliteStorageSessionStore.compact")(function* () {
    yield* writer.run(
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`.pipe(
          Effect.mapError((cause) =>
            storeError(
              "compact",
              "storage",
              "Could not inspect reusable database pages",
              undefined,
              cause
            )
          )
        )
        const freePages = rows[0]?.freelist_count
        if (freePages === undefined || !Number.isSafeInteger(freePages) || freePages < 0) {
          return yield* storeError(
            "compact",
            "storage",
            "SQLite reported an invalid reusable-page count"
          )
        }
        const pages = Math.min(freePages, 2_048)
        if (pages > 0) {
          yield* sql
            .unsafe(`PRAGMA incremental_vacuum(${pages})`)
            .pipe(
              Effect.mapError((cause) =>
                storeError(
                  "compact",
                  "storage",
                  "Could not compact reusable database pages",
                  undefined,
                  cause
                )
              )
            )
        }
        yield* sql
          .unsafe("PRAGMA wal_checkpoint(TRUNCATE)")
          .pipe(
            Effect.mapError((cause) =>
              storeError(
                "compact",
                "storage",
                "Could not checkpoint the compacted database",
                undefined,
                cause
              )
            )
          )
      })
    )
  })

  const breakdown = Effect.fn("SqliteStorageSessionStore.breakdown")(function* () {
    const fail = (message: string) => (cause: unknown) =>
      storeError("breakdown", "storage", message, undefined, cause)
    const { others, size, weights, counts } = yield* (
      filename === ":memory:" ? readBreakdown(sql) : measureOnOwnConnection(filename)
    ).pipe(Effect.mapError(fail("Could not measure the database")))

    const file = size[0]
    if (file === undefined) {
      return yield* storeError("breakdown", "storage", "SQLite reported no database size")
    }
    let knowledgeBytes = 0
    let tableHousekeepingBytes = 0
    for (const row of others) {
      if (row.name.startsWith("wiki_")) knowledgeBytes += row.bytes
      else tableHousekeepingBytes += row.bytes
    }
    const sessionBytes = file.bytes - file.free_bytes - knowledgeBytes - tableHousekeepingBytes
    if (sessionBytes < 0) {
      return yield* storeError(
        "breakdown",
        "storage",
        "Measured tables exceed the database's used pages"
      )
    }

    const kindOf = (type: string): "chats" | "channels" | "agents" => {
      if (type === "channel") return "channels"
      if (type === "agent") return "agents"
      return "chats"
    }
    const weight = { chats: 0, channels: 0, agents: 0 }
    for (const row of weights) weight[kindOf(row.session_type)] += row.bytes ?? 0
    const weightTotal = weight.chats + weight.channels + weight.agents
    const chatsBytes =
      weightTotal === 0 ? sessionBytes : Math.floor((sessionBytes * weight.chats) / weightTotal)
    const channelsBytes =
      weightTotal === 0 ? 0 : Math.floor((sessionBytes * weight.channels) / weightTotal)

    const count = (type: string) => counts.find((row) => row.session_type === type)
    return {
      fileBytes: file.bytes,
      chatsBytes,
      channelsBytes,
      agentsBytes: sessionBytes - chatsBytes - channelsBytes,
      knowledgeBytes,
      housekeepingBytes: tableHousekeepingBytes + file.free_bytes,
      currentChats: (count("chat")?.total ?? 0) - (count("chat")?.archived ?? 0),
      archivedChats: count("chat")?.archived ?? 0,
      channels: count("channel")?.total ?? 0,
      agentRuns: count("agent")?.total ?? 0
    }
  })

  return StorageSessionStore.of({ candidates, deleteCandidate, compact, breakdown })
}
