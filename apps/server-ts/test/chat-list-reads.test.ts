import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { automationRowSelect } from "../src/persistence/sqlite/automation-rows.js"
import { latestSessionRunQuery } from "../src/persistence/sqlite/session-latest-run.js"
import { activeRunStatusList } from "../src/persistence/sqlite/status-sets.js"
import { ownerNamedChats } from "../src/persistence/sqlite/transcript-search.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// The chat lists now read indexes in the order they ask for, the live list
// starts from the active runs, chat search reads only the owner's own chats,
// and an Automation's own chat is one lookup. These run the old SQL (kept
// only here) and the new reads on the same rows and expect the same answer.

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString()

interface Chat {
  readonly id: string
  readonly type?: "chat" | "channel" | "agent"
  readonly activity: number
  readonly accessed?: number
  readonly archived?: boolean
  readonly name?: string
  readonly space?: string
  readonly parent?: string
  readonly automation?: string
  readonly started?: number
}

const chats: ReadonlyArray<Chat> = [
  { id: "c-1", activity: 10, name: "Desk setup", space: "sp" },
  { id: "c-2", activity: 10, name: "Tie on time", accessed: 50 },
  { id: "c-3", activity: 30, name: "Archived", archived: true },
  { id: "c-4", activity: 20, accessed: 5 },
  { id: "c-5", activity: 40, name: "Named too", accessed: 40 },
  { id: "thread", activity: 1, name: "Automation chat" },
  { id: "fork-1", activity: 45, parent: "thread", automation: "auto-1", name: "A fork" },
  {
    id: "ch-1",
    type: "channel",
    activity: 5,
    automation: "auto-1",
    started: 3,
    name: "Old channel"
  },
  { id: "ch-2", type: "channel", activity: 6, automation: "auto-1", started: 8 },
  { id: "ch-3", type: "channel", activity: 7, automation: "auto-1", started: 9, archived: true },
  { id: "ch-4", type: "channel", activity: 7, automation: "auto-2", started: 1 },
  { id: "ag-1", type: "agent", activity: 25, parent: "c-1" },
  { id: "c-6", activity: 35, space: "sp" }
]

// Runs: c-1 and c-6 have an active latest run; c-4 had one, but a newer run
// ended; c-3 runs but is archived; ag-1 is pending.
const runs: ReadonlyArray<readonly [string, string, number]> = [
  ["r-1", "c-1", 9],
  ["r-6", "c-6", 30],
  ["r-4a", "c-4", 10],
  ["r-4b", "c-4", 15],
  ["r-3", "c-3", 20],
  ["r-ag", "ag-1", 21],
  ["r-5", "c-5", 22]
]
const status: Record<string, string> = {
  "r-1": "running",
  "r-6": "pending",
  "r-4a": "running",
  "r-4b": "completed",
  "r-3": "running",
  "r-ag": "pending",
  "r-5": "completed"
}

const seed = (sql: SqlClient.SqlClient) =>
  Effect.forEach(
    [
      `INSERT INTO spaces (space_id, name, name_key, created_at, updated_at)
         VALUES ('sp', 'Space', 'space', '${at(0)}', '${at(0)}')`,
      ...chats.map(
        (
          chat
        ) => `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, last_accessed_at,
            session_type, name, space_id, archived_at, parent_session_id, parent_run_id, parent_tool_call_id,
            origin_automation_id)
          VALUES ('${chat.id}', 'ref-${chat.id}', '${at(chat.started ?? 0)}', '${at(chat.activity)}',
            ${chat.accessed === undefined ? "NULL" : `'${at(chat.accessed)}'`}, '${chat.type ?? "chat"}',
            ${chat.name === undefined ? "NULL" : `'${chat.name}'`}, ${chat.space === undefined ? "NULL" : `'${chat.space}'`},
            ${chat.archived === true ? `'${at(60)}'` : "NULL"}, ${chat.parent === undefined ? "NULL" : `'${chat.parent}'`},
            ${chat.type === "agent" ? "'r-1'" : "NULL"}, ${chat.type === "agent" ? "'call-1'" : "NULL"},
            ${chat.automation === undefined ? "NULL" : `'${chat.automation}'`})`
      ),
      ...runs.map(
        ([
          run,
          session,
          minute
        ]) => `INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
            ended_at, metadata_json, assistant_message_id)
          VALUES ('${run}', '${session}', '${status[run]}', '${at(minute)}', '${at(minute)}',
            ${["running", "pending"].includes(status[run] ?? "") ? "NULL" : `'${at(minute)}'`},
            '{"turn_id":"t-${run}"}', 'am-${run}')`
      ),
      ...["auto-1", "auto-2", "auto-3"].map(
        (
          id,
          index
        ) => `INSERT INTO scheduled_tasks (task_id, automation_ref, name, prompt, triggers, created_at, thread_id)
          VALUES ('${id}', 'ref-${id}', '${id}', 'Check.', '[]', '${at(index)}', 'thread')`
      )
    ],
    (statement) => sql.unsafe(statement),
    { discard: true }
  )

it("the chat lists and chat search read what the old queries read", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessions = yield* SessionStore
      yield* seed(sql)
      const ids = (rows: ReadonlyArray<{ readonly sessionId: string }>) =>
        rows.map((row) => row.sessionId)

      // Live: the chats whose latest run is active, newest first.
      const oldLive = (extra: string, limit: number, offset: number) =>
        sql<{ readonly session_id: string }>`SELECT s.session_id FROM sessions AS s
          LEFT JOIN chat_runs AS latest_run ON latest_run.run_id = (${sql.literal(latestSessionRunQuery)})
          WHERE s.archived_at IS NULL ${sql.literal(extra)} AND latest_run.status IN ${activeRunStatusList}
          ORDER BY s.last_activity DESC, s.session_id DESC LIMIT ${limit} OFFSET ${offset}`
      const live = yield* sessions.list({ live: true })
      expect(ids(live)).toEqual((yield* oldLive("", 100, 0)).map((row) => row.session_id))
      expect(ids(live)).toEqual(["c-6", "ag-1", "c-1"])
      expect(ids(yield* sessions.list({ live: true, spaceId: "sp" }))).toEqual(
        (yield* oldLive("AND s.space_id = 'sp'", 100, 0)).map((row) => row.session_id)
      )
      expect(ids(yield* sessions.list({ live: true, limit: 1, offset: 1 }))).toEqual(
        (yield* oldLive("", 1, 1)).map((row) => row.session_id)
      )

      // Every live chat by activity, and by last opened.
      const oldOrder = (order: string) =>
        sql<{ readonly session_id: string }>`SELECT s.session_id FROM sessions AS s
          WHERE s.archived_at IS NULL ORDER BY ${sql.literal(order)} DESC, s.session_id DESC LIMIT 100`
      expect(ids(yield* sessions.list())).toEqual(
        (yield* oldOrder("s.last_activity")).map((row) => row.session_id)
      )
      expect(ids(yield* sessions.list({ sort: "accessed" }))).toEqual(
        (yield* oldOrder("COALESCE(s.last_accessed_at, s.last_activity)")).map(
          (row) => row.session_id
        )
      )

      // Chat search's named chats: the owner's own, newest first.
      const named = yield* ownerNamedChats(sql)
      const oldNamed = yield* sql`SELECT s.session_id, s.name, s.last_activity
        FROM sessions AS s
        WHERE s.archived_at IS NULL AND s.session_type = 'chat'
          AND s.parent_session_id IS NULL AND s.parent_message_id IS NULL AND s.name IS NOT NULL
        ORDER BY s.last_activity DESC`
      expect(named).toEqual(oldNamed)
      expect(named.map((row) => row.session_id)).toEqual(["c-5", "c-2", "c-1", "thread"])

      // An Automation's own chat: its newest live channel.
      const rows = yield* sql<Record<string, unknown>>`${automationRowSelect(sql)} ORDER BY task_id`
      const oldRows = yield* sql<Record<string, unknown>>`SELECT task_id,
          (SELECT session_id FROM sessions WHERE origin_automation_id = scheduled_tasks.task_id
            AND session_type = 'channel' AND archived_at IS NULL
            ORDER BY started_at DESC LIMIT 1) AS own_chat_id
        FROM scheduled_tasks ORDER BY task_id`
      expect(rows.map((row) => [row["task_id"], row["own_chat_id"]])).toEqual(
        oldRows.map((row) => [row["task_id"], row["own_chat_id"]])
      )
      expect(rows.map((row) => row["own_chat_id"])).toEqual(["ch-2", "ch-4", null])
    })
  )
})
