import { Effect } from "effect"
import { DayActivity } from "../automations/day-activity.js"
import type { PersistenceDeps } from "./deps.js"
import type { DayTaskEvent, DayItem } from "../automations/day-activity.js"

const KEPT_TASK_EVENTS = [
  "created",
  "done",
  "failed",
  "stalled",
  "blocked",
  "on_hold",
  "unblocked",
  "cancelled"
] as const

export const makeDayActivity = ({
  reader
}: Pick<PersistenceDeps, "reader">): {
  readonly read: (range: {
    readonly start: string
    readonly end: string
  }) => Effect.Effect<
    { readonly taskEvents: ReadonlyArray<DayTaskEvent>; readonly items: ReadonlyArray<DayItem> },
    Error
  >
} => {
  const sql = reader
  const read: DayActivity["Service"]["read"] = Effect.fn("DayActivity.read")(
    function* ({ start, end }) {
      const taskEvents = yield* sql<{
        readonly item_id: string
        readonly title: string
        readonly space_name: string | null
        readonly event_type: string
        readonly created_at: string
        readonly summary: string | null
      }>`
        SELECT event.item_id, task.text AS title, space.name AS space_name, event.event_type,
          event.created_at, COALESCE(event.result_summary, event.summary) AS summary
        FROM space_task_events AS event
        JOIN space_tasks AS task ON task.item_id = event.item_id
        LEFT JOIN spaces AS space ON space.space_id = task.space_id
        WHERE event.created_at >= ${start} AND event.created_at < ${end}
          AND event.event_type IN ${sql.in(KEPT_TASK_EVENTS)}
        ORDER BY event.created_at, event.event_id`
      const items = yield* sql<{
        readonly item_id: string
        readonly source: string
        readonly received_at: string
        readonly sender: string | null
        readonly title: string
        readonly snippet: string
        readonly sent_by_owner: number
      }>`
        SELECT MIN(item.item_id) AS item_id, item.source, MIN(item.received_at) AS received_at,
          item.sender, item.title, item.snippet,
          MAX(COALESCE(json_extract(item.detail, '$.sent_by_owner'), 0)) AS sent_by_owner
        FROM connection_items AS item
        WHERE julianday(item.received_at) >= julianday(${start})
          AND julianday(item.received_at) < julianday(${end})
        GROUP BY item.source, item.title, item.sender, substr(item.received_at, 1, 16)
        ORDER BY received_at, item_id`
      return {
        taskEvents: taskEvents.map((row) => ({
          itemId: row.item_id,
          title: row.title,
          spaceName: row.space_name ?? undefined,
          type: row.event_type,
          at: row.created_at,
          summary: row.summary ?? undefined
        })),
        items: items.map((row) => ({
          itemId: row.item_id,
          source: row.source,
          receivedAt: row.received_at,
          sender: row.sender ?? undefined,
          title: row.title,
          snippet: row.snippet,
          sentByOwner: row.sent_by_owner === 1
        }))
      }
    },
    Effect.mapError((cause) => new Error("Could not read the day's Tasks and items", { cause }))
  )
  return DayActivity.of({ read })
}
