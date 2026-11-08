import type { RecordToldStatus } from "@arden-hq/protocol"
import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { failureNeedsOwner } from "./run-attention.js"
import type { EndingStatus, PlaceKind, Purpose } from "../runs/ending.js"
import { isUserAutomationPurpose } from "../job-classification.js"

export interface Notice {
  readonly key: string
  readonly record: "ending" | "entity"
  readonly status: RecordToldStatus
  readonly shown: boolean
  readonly title: string
  readonly text: string
  readonly chatSessionId: string | null
  readonly automationId: string | null
  readonly itemId: string | null
  readonly unread: boolean
  readonly occurredAt: string
  readonly purpose: Purpose | null
}

interface EndingFacts {
  readonly purpose: Purpose
  readonly status: EndingStatus
  readonly placeKind: PlaceKind
  readonly drawn: boolean
  readonly primaryChat: boolean
  readonly listed: boolean
  readonly entityTold: boolean
}

const endingShown = (facts: EndingFacts): boolean => {
  if (facts.entityTold || facts.placeKind === "parent") return false
  switch (facts.status) {
    case "cancelled":
    case "silent":
    case "waiting":
      return false
    case "failed":
      return facts.drawn || facts.listed
    case "blocked":
      return facts.drawn
    case "finished":
      return (
        facts.drawn ||
        (facts.placeKind === "own" &&
          ((facts.purpose === "chat" && facts.primaryChat) ||
            isUserAutomationPurpose(facts.purpose)))
      )
  }
}

interface EndingRow {
  readonly run_id: string
  readonly purpose: Purpose
  readonly status: EndingStatus
  readonly text: string
  readonly place: string | null
  readonly place_kind: PlaceKind
  readonly occurred_at: string
  readonly shown: number
  readonly own_session: string
  readonly own_name: string | null
  readonly own_type: string | null
  readonly own_parent: string | null
  readonly own_unread: number
  readonly place_unread: number | null
  readonly automation_id: string | null
  readonly automation_name: string | null
  readonly item_id: string | null
  readonly task_name: string | null
  readonly listed: number
  readonly entity_told: number
}

const endingRows = (sql: SqlClient.SqlClient, filter: Statement.Fragment) =>
  sql<EndingRow>`SELECT ending.run_id, ending.purpose, ending.status, ending.text, ending.place,
      ending.place_kind, ending.occurred_at, ending.shown,
      chat.session_id AS own_session, own.name AS own_name, own.session_type AS own_type,
      own.parent_session_id AS own_parent, own.has_unread AS own_unread,
      placed.has_unread AS place_unread,
      json_extract(chat.metadata_json, '$.run_context.origin.automation_id') AS automation_id,
      (SELECT name FROM scheduled_tasks WHERE task_id =
        json_extract(chat.metadata_json, '$.run_context.origin.automation_id')) AS automation_name,
      COALESCE(json_extract(chat.metadata_json, '$.run_context.task.item_id'),
        json_extract(chat.metadata_json, '$.run_context.origin.item_id')) AS item_id,
      (SELECT text FROM space_tasks WHERE item_id =
        COALESCE(json_extract(chat.metadata_json, '$.run_context.task.item_id'),
          json_extract(chat.metadata_json, '$.run_context.origin.item_id'))) AS task_name,
      ${failureNeedsOwner(sql)} AS listed,
      EXISTS (SELECT 1 FROM entity_events AS done
        WHERE done.run_id = ending.run_id AND done.event IN ('done', 'failed')) AS entity_told
    FROM run_endings AS ending
    JOIN chat_runs AS chat ON chat.run_id = ending.run_id
    JOIN sessions AS own ON own.session_id = chat.session_id
    LEFT JOIN sessions AS placed ON placed.session_id = ending.place
    WHERE ending.decided = 1 AND ${filter}`

const noticeOfEnding = (row: EndingRow): Notice => {
  const shown = endingShown({
    purpose: row.purpose,
    status: row.status,
    placeKind: row.place_kind,
    drawn: row.shown === 1,
    primaryChat: row.own_type === "chat" && row.own_parent === null,
    listed: row.listed === 1,
    entityTold: row.entity_told === 1
  })
  const placed = row.place_kind === "chat" && row.place !== null
  return {
    key: `ending:${row.run_id}`,
    record: "ending",
    status: row.status,
    shown,
    title: row.automation_name ?? row.task_name ?? row.own_name ?? "",
    text: row.text,
    chatSessionId: placed && !isUserAutomationPurpose(row.purpose) ? row.place : row.own_session,
    automationId: row.automation_id,
    itemId: row.item_id,
    unread: (placed ? row.place_unread : row.own_unread) === 1,
    occurredAt: row.occurred_at,
    purpose: row.purpose
  }
}

interface EntityRow {
  readonly key: string
  readonly entity: "task" | "automation"
  readonly entity_id: string
  readonly event: "done" | "paused" | "failed"
  readonly text: string
  readonly place: string | null
  readonly occurred_at: string
  readonly shown: number
  readonly place_unread: number | null
  readonly automation_name: string | null
  readonly task_name: string | null
}

const entityRows = (sql: SqlClient.SqlClient, filter: Statement.Fragment) =>
  sql<EntityRow>`SELECT event.key, event.entity, event.entity_id, event.event, event.text,
      event.place, event.occurred_at, event.shown, placed.has_unread AS place_unread,
      (SELECT name FROM scheduled_tasks WHERE task_id = event.entity_id) AS automation_name,
      (SELECT text FROM space_tasks WHERE item_id = event.entity_id) AS task_name
    FROM entity_events AS event
    LEFT JOIN sessions AS placed ON placed.session_id = event.place
    WHERE ${filter}`

const noticeOfEntity = (row: EntityRow): Notice => ({
  key: row.key,
  record: "entity",
  status: row.event,
  shown: row.shown === 1,
  title: (row.entity === "task" ? row.task_name : row.automation_name) ?? "",
  text: row.text,
  chatSessionId: row.place,
  automationId: row.entity === "automation" ? row.entity_id : null,
  itemId: row.entity === "task" ? row.entity_id : null,
  unread: row.place_unread === null || row.place_unread === 1,
  occurredAt: row.occurred_at,
  purpose: null
})

const readNotice = Effect.fn("Notices.read")(function* (sql: SqlClient.SqlClient, key: string) {
  if (key.startsWith("ending:")) {
    const rows = yield* endingRows(sql, sql`ending.run_id = ${key.slice("ending:".length)}`)
    return rows[0] === undefined ? undefined : noticeOfEnding(rows[0])
  }
  const rows = yield* entityRows(sql, sql`event.key = ${key}`)
  return rows[0] === undefined ? undefined : noticeOfEntity(rows[0])
})

export const recentNotices = Effect.fn("Notices.recent")(function* (
  sql: SqlClient.SqlClient,
  query: { readonly since: string; readonly limit: number }
) {
  const endings = yield* endingRows(sql, sql`ending.occurred_at >= ${query.since}`)
  const entities = yield* entityRows(sql, sql`event.occurred_at >= ${query.since}`)
  return [...endings.map(noticeOfEnding), ...entities.map(noticeOfEntity)]
    .filter((notice) => notice.shown)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, query.limit)
})

export const announceNotice = Effect.fn("Notices.announce")(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: SessionLifecycleEvents["Service"],
  key: string
) {
  const notice = yield* readNotice(sql, key)
  if (notice === undefined || !notice.shown) return
  yield* sessionEvents.appendEventInTransaction({
    type: "record_told",
    key: notice.key,
    record: notice.record,
    status: notice.status,
    shown: notice.shown,
    unread: true,
    title: notice.title,
    text: notice.text,
    chat_session_id: notice.chatSessionId,
    automation_id: notice.automationId,
    item_id: notice.itemId
  })
})
