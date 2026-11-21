import { WORK_TASK_KEY_MAX_CHARS } from "@arden-hq/protocol/spaces/work"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { Backfill, BackfillContext } from "./backfills/backfill.js"
import { mainSpaceId } from "./main-space.js"
import { taskJobId } from "../space-job-id.js"

const CHATS_PER_CHUNK = 200

const looseChat = "space_id IS NULL AND origin_automation_id IS NULL"

const freeTaskKey = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`
    const candidate = `${base.slice(0, WORK_TASK_KEY_MAX_CHARS - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

export const mainSpaceChatsBackfill: Backfill<unknown, BackfillContext> = {
  name: "main_space_chats",
  chunk: Effect.fn("MainSpaceChats.backfillChunk")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const chats = yield* sql<{ readonly session_id: string }>`SELECT session_id FROM sessions
      WHERE session_id > ${cursor ?? ""} AND ${sql.literal(looseChat)}
      ORDER BY session_id LIMIT ${Math.min(limit, CHATS_PER_CHUNK)}`
    const last = chats.at(-1)
    if (last === undefined) return { converted: 0, next: undefined }
    const main = yield* mainSpaceId(sql)
    const ids = chats.map((chat) => chat.session_id)
    yield* sql`UPDATE sessions SET space_id = ${main}
      WHERE session_id IN ${sql.in(ids)} AND ${sql.literal(looseChat)}`
    const tasks = yield* sql<{ readonly item_id: string; readonly stable_key: string }>`
      SELECT item_id, stable_key FROM space_tasks
      WHERE space_id IS NULL AND home_session_id IN ${sql.in(ids)}
      ORDER BY created_at, item_id`
    if (tasks.length > 0) {
      const taken = new Set(
        (yield* sql<{ readonly stable_key: string }>`
          SELECT stable_key FROM space_tasks WHERE space_id = ${main}`).map((row) => row.stable_key)
      )
      for (const task of tasks) {
        const key = freeTaskKey(task.stable_key, taken)
        taken.add(key)
        yield* sql`UPDATE space_tasks SET space_id = ${main}, stable_key = ${key}
          WHERE item_id = ${task.item_id}`
      }
      const itemIds = tasks.map((task) => task.item_id)
      yield* sql`UPDATE sessions SET space_id = ${main}
        WHERE space_id IS NULL AND origin_automation_id IN ${sql.in(itemIds.map(taskJobId))}`
      for (const table of ["space_task_events", "space_task_comments", "space_task_attachments"])
        yield* sql`UPDATE ${sql(table)} SET space_id = ${main}
          WHERE space_id IS NULL AND item_id IN ${sql.in(itemIds)}`
    }
    return { converted: ids.length, next: last.session_id }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM sessions
      WHERE ${sql.literal(looseChat)}`
    return rows[0]?.count ?? 0
  })
}
