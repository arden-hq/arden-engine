import { HOME_HEADLINES } from "@arden-hq/protocol/effect/runs"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { makeHomeEvidence } from "../src/persistence/sqlite/home-evidence.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const HOUR = 3_600_000
const NOW = Date.now()
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString()

const space = `INSERT INTO spaces (space_id, name, name_key, created_at, updated_at)
  VALUES ('sp', 'Live', 'live', '${at(900)}', '${at(900)}')`

const task = (id: string, status: string) =>
  `INSERT INTO space_tasks (item_id, space_id, stable_key, text, status, owner, created_at, updated_at, generation)
   VALUES ('${id}', 'sp', '${id}', 'Task ${id}', '${status}', 'worker', '${at(900)}', '${at(900)}', 0)`

const event = (id: string, type: string, summary: string, hoursAgo: number) =>
  `INSERT INTO space_task_events (space_id, item_id, event_type, summary, created_at)
   VALUES ('sp', '${id}', '${type}', '${summary}', '${at(hoursAgo)}')`

const comment = (author: string, body: string, hoursAgo: number) =>
  `INSERT INTO space_task_comments (space_id, item_id, author, body, created_at)
   VALUES ('sp', 'open', '${author}', '${body}', '${at(hoursAgo)}')`

const exec = (sql: SqlClient.SqlClient, statements: ReadonlyArray<string>) =>
  Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true })

it("lists only news from the window, newest first, and says nothing needs the user", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* exec(sql, [
        space,
        task("open", "open"),
        task("deferred", "deferred"),
        event("open", "updated", "Older step", 10),
        event("open", "updated", "Newer step", 2),
        event("open", "updated", "Before the window", 100),
        event("open", "scheduled", "Scheduled only", 3),
        event("deferred", "updated", "Deferred step", 4),
        comment("worker", "Worker note", 5),
        comment("user", "My own note", 6)
      ])
      const page = yield* makeHomeEvidence({ sql, consistent: (read) => read })({ since: at(48) })
      const summaries = page.entries.map((entry) =>
        "summary" in entry ? entry.summary : undefined
      )
      expect(summaries).toEqual(["Newer step", "Worker note", "Older step"])
      expect(page.headline).toBe(HOME_HEADLINES[0])
      expect(page.next_cursor).toBeNull()
    })
  )
})

it("headlines an open question as something that needs the user", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* exec(sql, [
        `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type, name)
         VALUES ('chat', 'ref-chat', '${at(1000)}', '${at(1)}', 'chat', 'Chat')`,
        `INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, ended_at, metadata_json, assistant_message_id)
         VALUES ('run', 'chat', 'completed', '${at(6)}', '${at(5)}', '${at(5)}',
           '{"turn_id":"t","run_context":{"origin":{"kind":"chat","session_id":"chat","turn_id":"t"},"task":null}}', 'am')`,
        `INSERT INTO run_questions (question_id, run_id, tool_call_id, content, created_at)
         VALUES ('q', 'run', 'call-q', '{"prompt":"Which one?","detail":null,"choices":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}', '${at(4)}')`
      ])
      const page = yield* makeHomeEvidence({ sql, consistent: (read) => read })({ since: at(48) })
      expect(page.entries.map((entry) => entry.kind)).toEqual(["question"])
      expect(page.headline).toBe(HOME_HEADLINES[1])
    })
  )
})

it("pages a long window without repeating or dropping an entry", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* exec(sql, [
        space,
        task("open", "open"),
        ...Array.from({ length: 130 }, (_, index) =>
          comment("worker", `Note ${index}`, 1 + index / 10)
        )
      ])
      const read = makeHomeEvidence({ sql, consistent: (readOnly) => readOnly })
      const since = at(48)
      const first = yield* read({ since })
      expect(first.entries).toHaveLength(100)
      const cursor = first.next_cursor
      if (cursor === null) throw new Error("expected a second page")
      const second = yield* read({ since, cursor })
      expect(second.entries).toHaveLength(30)
      expect(second.next_cursor).toBeNull()
      const ids = [...first.entries, ...second.entries].map((entry) => entry.id)
      expect(new Set(ids).size).toBe(130)
      expect(first.entries[0]).toMatchObject({ summary: "Note 0" })
      expect(second.entries.at(-1)).toMatchObject({ summary: "Note 129" })
    })
  )
})
