import { SqliteClient } from "@effect/sql-sqlite-node"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

import {
  findChatEvents,
  takeChatEventsBeforeQueued
} from "../src/persistence/sqlite/chat-events.js"
import { initializeSchema } from "./fixtures/initialize-schema.js"

// A fork copies its parent's messages and keeps their ids. The Space's main chat reads
// arrivals from every chat in its Space, so each copy used to count as one more arrival
// with the same key, and saving the keys broke the (session_id, event_key) primary key.
// That failed every message sent to the main chat ("Could not record chat events").

const HOME = "home-chat"
const SPACE = "space-1"
const NOW = "2026-11-05T12:00:00.000Z"
const ARRIVED = "2026-11-05T05:36:56.760Z"

const run = <A>(test: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>): Promise<A> =>
  (async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-chat-events-"))
    try {
      return await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* initializeSchema(sql)
          return yield* test(sql)
        }).pipe(Effect.provide(SqliteClient.layer({ filename: join(directory, "arden.db") })))
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })()

const arrival = (id: string, forkedFrom?: string) => ({
  message_id: `arrival:${id}`,
  role: "user",
  created_at: ARRIVED,
  is_meta: true,
  update: {
    key: `task-event:${id}`,
    weight: "news",
    event: "finished",
    line: "Saved the brief.",
    door: {
      kind: "task",
      label: "Prepare the brief",
      item_id: "work:space-1:brief",
      href: "arden:task/work%3Aspace-1%3Abrief"
    }
  },
  ...(forkedFrom === undefined ? {} : { forked_from: forkedFrom })
})

const addChat = (sql: SqlClient.SqlClient, sessionId: string, parent?: string) =>
  sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type,
      space_id, parent_session_id, parent_message_id, origin_automation_id)
    VALUES (${sessionId}, ${`ref-${sessionId}`}, ${ARRIVED}, ${ARRIVED}, 'chat', ${SPACE},
      ${parent ?? null}, ${parent === undefined ? null : "arrival:a"},
      ${parent === undefined ? null : "automation-1"})`

const addMessage = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  seq: number,
  message: ReturnType<typeof arrival>
) =>
  sql`INSERT INTO session_messages (session_id, message_id, seq, role, message_json, created_at)
    VALUES (${sessionId}, ${message.message_id}, ${seq}, 'user', ${JSON.stringify(message)}, ${ARRIVED})`

const setUp = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO spaces (space_id, name, name_key, created_at, updated_at)
      VALUES (${SPACE}, 'Jobs', 'jobs', ${ARRIVED}, ${ARRIVED})`
    yield* addChat(sql, HOME)
    yield* sql`INSERT INTO space_conversations (space_id, session_id) VALUES (${SPACE}, ${HOME})`
    yield* addMessage(sql, HOME, 1, arrival("a"))
    for (const fork of [`${HOME}::f1`, `${HOME}::f2`]) {
      yield* addChat(sql, fork, HOME)
      yield* addMessage(sql, fork, 1, arrival("a", HOME))
    }
  })

const now = DateTime.makeUnsafe(NOW)

it("does not tell the main chat about its own arrival through fork copies", () =>
  run((sql) =>
    Effect.gen(function* () {
      yield* setUp(sql)
      const look = yield* findChatEvents(sql, { sessionId: HOME, now })
      expect(look?.batch).toBeUndefined()
    })
  ))

it("tells the main chat once about an arrival that came to a fork", () =>
  run((sql) =>
    Effect.gen(function* () {
      yield* setUp(sql)
      yield* addMessage(sql, `${HOME}::f1`, 2, arrival("b"))
      const look = yield* findChatEvents(sql, { sessionId: HOME, now })
      expect(look?.batch?.keys).toEqual(["arrival:b"])
    })
  ))

it("records chat events for a main chat that has forks", () =>
  run((sql) =>
    Effect.gen(function* () {
      yield* setUp(sql)
      yield* addMessage(sql, `${HOME}::f1`, 2, arrival("b"))
      yield* takeChatEventsBeforeQueued(sql, {
        run: { session_id: HOME, automation_context_mode: null },
        queued: 1,
        now,
        operation: "drain"
      })
      const saved = yield* sql<{ readonly event_key: string }>`
        SELECT event_key FROM chat_event_deliveries WHERE session_id = ${HOME}`
      expect(saved.map((row) => row.event_key)).toEqual(["arrival:b"])
    })
  ))
