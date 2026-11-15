import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { taskJobId } from "../src/persistence/space-job-id.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const AT = "2026-11-01T00:00:00.000Z"

const ownChats = (sql: SqlClient.SqlClient, automationId: string) =>
  sql<{ readonly name: string | null }>`
    SELECT name FROM sessions WHERE origin_automation_id = ${automationId}
      AND session_type = 'channel' ORDER BY started_at, session_id`.pipe(
    Effect.map((rows) => rows.map((row) => row.name))
  )

it("an owner Automation's edit renames its chats that carry its old name and keeps a name the owner gave one", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const made = (name: string, key: string) =>
        Effect.gen(function* () {
          const automation = yield* catalog.create(
            {
              name,
              prompt: "Made-up prompt",
              history: "chat",
              triggers: [{ type: "time", every: "1d" }],
              idempotency_key: key,
              idempotency_scope: "global"
            },
            "owner"
          )
          return AutomationId.make(automation.task_id)
        })
      const followed = yield* made("Made-up one", "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b")
      const kept = yield* made("Made-up two", "2f3e4d5c-6b7a-4899-8a1b-2c3d4e5f6a7b")
      yield* sql`UPDATE sessions SET name = 'My own name' WHERE origin_automation_id = ${kept}`
      yield* catalog.update(followed, { name: "Made-up first" }, "owner")
      yield* catalog.update(kept, { name: "Made-up second" }, "owner")
      return { followed: yield* ownChats(sql, followed), kept: yield* ownChats(sql, kept) }
    })
  )
  expect(outcome).toEqual({ followed: ["Made-up first"], kept: ["My own name"] })
})

it("a renamed Task's chats follow while they carry its old name, open or archived; a name the owner gave stays", async () => {
  const names = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
        VALUES ('space-1', 'Made-up Space', 'made-up space', '{"enabled":false}', ${AT}, ${AT})`
      const work = yield* WorkStore
      const task = yield* work.create(
        { kind: "space", spaceId: "space-1" },
        { key: "made-up", text: "Made-up Task" }
      )
      const job = taskJobId(task.item_id)
      const [named] = yield* sql<{ readonly name: string }>`
        SELECT name FROM scheduled_tasks WHERE task_id = ${job}`
      if (named === undefined) throw new Error("the Task has no job")
      const ownChat = (id: string, name: string, archived: boolean) =>
        sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, name,
            session_type, origin_automation_id, archived_at)
          VALUES (${id}, ${`chat~${id}`}, ${AT}, ${AT}, ${name}, 'channel', ${job},
            ${archived ? AT : null})`
      yield* ownChat("open", named.name, false)
      yield* ownChat("archived", named.name, true)
      yield* ownChat("owner-named", "My own name", false)
      const [current] = yield* sql<{ readonly updated_at: string }>`
        SELECT updated_at FROM space_tasks WHERE item_id = ${task.item_id}`
      yield* work.update({ kind: "item", itemId: task.item_id }, current?.updated_at ?? AT, {
        text: "Made-up Task renamed"
      })
      const [renamed] = yield* sql<{ readonly name: string }>`
        SELECT name FROM scheduled_tasks WHERE task_id = ${job}`
      const chats = yield* sql<{ readonly name: string; readonly archived: number }>`
        SELECT name, archived_at IS NOT NULL AS archived FROM sessions
        WHERE origin_automation_id = ${job} AND session_type = 'channel'`
      return chats
        .map((chat) => ({
          name: chat.name === renamed?.name ? "the Task's new name" : chat.name,
          archived: chat.archived === 1
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || Number(a.archived) - Number(b.archived))
    })
  )
  // The job's thread, made with the Task, and the two own chats that carry its name follow.
  expect(names).toEqual([
    { name: "My own name", archived: false },
    { name: "the Task's new name", archived: false },
    { name: "the Task's new name", archived: false },
    { name: "the Task's new name", archived: true }
  ])
})
