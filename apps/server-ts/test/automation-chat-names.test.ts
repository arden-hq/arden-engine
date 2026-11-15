import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

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
