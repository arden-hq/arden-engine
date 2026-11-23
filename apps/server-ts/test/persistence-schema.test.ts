import { ROLE } from "@arden-hq/std/message-vocabulary"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "vitest"
import { databaseSchema } from "../src/persistence/schema/database.js"
import { LATEST_SCHEMA_VERSION } from "../src/persistence/migrations/index.js"
import { StorageStartupError } from "../src/persistence/service.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"
import { rebuildSessionTurns } from "../src/persistence/sqlite/turns.js"
import { diagnosticsLayer } from "../src/runtime/diagnostics.js"

const createSchemaFile = (
  filename: string,
  mutate: (database: DatabaseSync) => void = () => {}
): void => {
  const database = new DatabaseSync(filename)
  try {
    database.exec("PRAGMA foreign_keys = ON")
    database.exec("BEGIN IMMEDIATE")
    for (const statement of databaseSchema.statements) database.exec(statement)
    database.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`)
    database.exec("COMMIT")
    mutate(database)
  } finally {
    database.close()
  }
}

const useInitializedDatabase = <A>(
  filename: string,
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* use(sql)
  }).pipe(
    Effect.provide(
      sqlitePersistenceLayer({ dataDir: null, filename }).pipe(
        Layer.provide(PersistenceWriteQueue.layer),
        Layer.provideMerge(
          Layer.merge(
            SqliteClient.layer({ filename }),
            diagnosticsLayer({
              startupPhase: () => {},
              migration: () => {},
              operational: () => {}
            })
          )
        )
      )
    )
  )

describe("persistence schema", () => {
  it("groups the durable turn index by the write path's turn stamps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-turn-media-"))
    const filename = join(directory, "turn-media.db")
    try {
      const turns = await Effect.runPromise(
        useInitializedDatabase(filename, (sql) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity)
          VALUES ('turn-media', 'turn-media-ref', '2026-08-28T00:00:00.000Z',
            '2026-08-28T00:00:06.000Z')`
            const rows = [
              [
                "user-1",
                0,
                "user",
                null,
                { role: ROLE.user, content: "Inspect it", turn_id: "user-1" }
              ],
              [
                "assistant-1",
                1,
                "assistant",
                null,
                { role: ROLE.assistant, content: null, turn_id: "user-1" }
              ],
              [
                "tool-1",
                2,
                "tool",
                null,
                { role: ROLE.tool, tool_call_id: "call-1", content: "ok", turn_id: "user-1" }
              ],
              [
                "media-1",
                3,
                "user",
                "tool-media:call-1",
                { role: ROLE.user, is_meta: true, content: [], turn_id: "user-1" }
              ],
              [
                "assistant-2",
                4,
                "assistant",
                null,
                { role: ROLE.assistant, content: "Done", turn_id: "user-1" }
              ],
              [
                "user-focus",
                5,
                "user",
                "focus:g-1:run-1",
                { role: ROLE.user, is_meta: true, content: "Continue", turn_id: "user-focus" }
              ],
              [
                "assistant-focus",
                6,
                "assistant",
                null,
                { role: ROLE.assistant, content: "More", turn_id: "user-focus" }
              ],
              [
                "user-2",
                7,
                "user",
                "user-2",
                { role: ROLE.user, content: "Next", turn_id: "user-2" }
              ],
              ["assistant-3", 8, "assistant", null, { role: ROLE.assistant, content: "Next done" }]
            ] as const
            for (const [messageId, sequence, role, clientId, message] of rows) {
              const createdAt = `2026-08-28T00:00:0${sequence}.000Z`
              yield* sql`INSERT INTO session_messages (
            session_id, message_id, seq, role, message_json, client_id, created_at
          ) VALUES (
            'turn-media', ${messageId}, ${sequence}, ${role}, ${JSON.stringify(message)},
            ${clientId}, ${createdAt}
          )`
            }
            yield* sql`INSERT OR REPLACE INTO message_turns (message_rowid, turn_id)
              SELECT message_rowid, 'user-2' FROM session_messages
              WHERE session_id = 'turn-media' AND message_id = 'assistant-3'`
            yield* rebuildSessionTurns(sql, "turn-media")
            return yield* sql<{
              readonly user_message_id: string
              readonly message_start_seq: number
              readonly message_end_seq: number
            }>`SELECT user_message_id, message_start_seq, message_end_seq
          FROM session_turns WHERE session_id = 'turn-media' ORDER BY turn_index`
          })
        )
      )

      expect(turns).toEqual([
        { user_message_id: "user-1", message_start_seq: 0, message_end_seq: 4 },
        { user_message_id: "user-focus", message_start_seq: 5, message_end_seq: 6 },
        { user_message_id: "user-2", message_start_seq: 7, message_end_seq: 8 }
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("enforces the ownership constraints between deliveries, agent sessions, rules and attachments", () => {
    const database = new DatabaseSync(":memory:")
    try {
      database.exec("PRAGMA foreign_keys = ON")
      database.exec("BEGIN IMMEDIATE")
      for (const statement of databaseSchema.statements) database.exec(statement)
      database.exec("COMMIT")

      database.exec(`INSERT INTO scheduled_tasks
        (task_id, automation_ref, prompt, triggers, created_at, tool_scope, purpose)
        VALUES ('browser-scope', 'browser-scope-ref', 'Prompt', '[]',
          '2026-08-20T00:00:00+00:00', 'browser', 'system')`)
      database.exec(`INSERT INTO automation_deliveries
        (delivery_id, task_id, delivered_at, subject, body, destinations)
        VALUES ('${"a".repeat(64)}', 'browser-scope', '2026-08-24T05:00:00Z',
          'Subject', 'Body', '["email"]')`)
      expect(() =>
        database.exec(`INSERT INTO automation_deliveries
        (delivery_id, task_id, delivered_at, subject, body, destinations)
        VALUES ('${"c".repeat(64)}', 'missing', '2026-08-24T05:00:00Z',
          'Subject', 'Body', '[]')`)
      ).toThrow()
      database.exec("DELETE FROM scheduled_tasks WHERE task_id = 'browser-scope'")
      expect(database.prepare("SELECT COUNT(*) AS count FROM automation_deliveries").get()).toEqual(
        { count: 1 }
      )
      expect(database.prepare("SELECT task_id FROM automation_deliveries").get()).toEqual({
        task_id: null
      })

      database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity)
        VALUES ('session-1', 'public-1', '2026-08-20T00:00:00+00:00', '2026-08-20T00:00:00+00:00')`)
      expect(() =>
        database.exec(`INSERT INTO sessions
        (session_id, public_ref, started_at, last_activity, session_type)
        VALUES ('bad-agent', 'bad-agent-ref', '2026-08-20T00:00:00+00:00',
          '2026-08-20T00:00:00+00:00', 'agent')`)
      ).toThrow()
      database.exec(`INSERT INTO sessions
        (session_id, public_ref, started_at, last_activity, session_type,
          parent_session_id, parent_run_id, parent_tool_call_id)
        VALUES ('agent-1', 'agent-ref-1', '2026-08-20T00:00:00+00:00',
          '2026-08-20T00:00:00+00:00', 'agent', 'session-1', 'parent-run', 'spawn-1')`)
      expect(() =>
        database.exec(`INSERT INTO sessions
        (session_id, public_ref, started_at, last_activity, session_type,
          parent_session_id, parent_run_id, parent_tool_call_id)
        VALUES ('agent-2', 'agent-ref-2', '2026-08-20T00:00:00+00:00',
          '2026-08-20T00:00:00+00:00', 'agent', 'session-1', 'parent-run', 'spawn-1')`)
      ).toThrow()

      const hostRule = (id: string, decision: string) =>
        database.exec(`INSERT INTO permission_rules
          (rule_id, list_kind, subject_kind, decision, source_kind, created_at)
          VALUES ('${id}', 'global', 'host_commands', '${decision}', 'settings',
            '2026-08-20T00:00:00+00:00')`)
      hostRule("host", "ask")
      expect(() => hostRule("host-again", "ask")).toThrow()
      expect(() => hostRule("host-allowed", "allow")).toThrow()
      expect(() =>
        database.exec(`INSERT INTO permission_rules
          (rule_id, list_kind, subject_kind, tool_name, decision, source_kind, created_at)
          VALUES ('loose', 'space', 'tool', 'browser_act', 'allow', 'settings',
            '2026-08-20T00:00:00+00:00')`)
      ).toThrow()

      database.exec(`INSERT INTO spaces
        (space_id, name, name_key, created_at, updated_at)
        VALUES ('space-1', 'Space', 'space',
          '2026-08-20T00:00:00+00:00', '2026-08-20T00:00:00+00:00')`)
      database.exec(`INSERT INTO space_tasks
        (item_id, space_id, stable_key, text, status, owner, blocked,
          created_at, updated_at)
        VALUES ('work-1', 'space-1', 'work', 'Work', 'open', 'user', 0,
          '2026-08-20T00:00:00+00:00', '2026-08-20T00:00:00+00:00')`)
      expect(() =>
        database.exec(`INSERT INTO space_task_attachments
        (space_id, item_id, name, media_type, data, size, created_by, created_at)
        VALUES ('space-1', 'work-1', 'bad.txt', 'text/plain', 'text', 4, 'user',
          '2026-08-20T00:00:00+00:00')`)
      ).toThrow()
      database
        .prepare(
          `INSERT INTO space_task_attachments
        (space_id, item_id, name, media_type, data, size, created_by, created_at)
        VALUES ('space-1', 'work-1', 'ok.bin', 'application/octet-stream', ?, 2,
          'user', '2026-08-20T00:00:00+00:00')`
        )
        .run(Buffer.from([1, 2]))
      database.exec("DELETE FROM space_tasks WHERE item_id = 'work-1'")
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM space_task_attachments").get()
      ).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  })

  it("requires explicit conversion for missing owned objects without mutating the database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-schema-missing-"))
    const filename = join(directory, "missing.db")

    try {
      createSchemaFile(filename, (database) => {
        database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity)
          VALUES ('s-current', 'ref-current', '2026-08-22T00:00:00Z', '2026-08-22T00:00:00Z')`)
        database.exec("DROP TABLE session_queued_messages")
      })

      const result = await Effect.runPromiseExit(
        useInitializedDatabase(filename, () => Effect.succeed(undefined))
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const error = Cause.squash(result.cause)
        expect(error).toBeInstanceOf(StorageStartupError)
      }

      const database = new DatabaseSync(filename)
      try {
        expect(
          database
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_queued_messages'")
            .all()
        ).toEqual([])
        expect(
          database.prepare("SELECT session_id FROM sessions WHERE session_id = 's-current'").all()
        ).toEqual([{ session_id: "s-current" }])
      } finally {
        database.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("rejects changed schema definitions and same-name object types", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-schema-manifest-"))
    const cases = [
      {
        name: "monitor_state",
        mutate: (database: DatabaseSync) =>
          database.exec(`
          DROP TABLE monitor_state;
          CREATE TABLE monitor_state (
            namespace TEXT PRIMARY KEY,
            state TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            generation INTEGER NOT NULL DEFAULT 0
          )
        `)
      },
      {
        name: "idx_sessions_activity",
        mutate: (database: DatabaseSync) =>
          database.exec(`
          DROP INDEX idx_sessions_activity;
          CREATE INDEX idx_sessions_activity ON sessions(started_at)
        `)
      },
      {
        name: "trigger:idx_sessions_activity",
        mutate: (database: DatabaseSync) =>
          database.exec(`
          CREATE TRIGGER idx_sessions_activity
          AFTER INSERT ON sessions BEGIN SELECT 1; END
        `)
      },
      {
        name: "trigger:foreign_writer",
        mutate: (database: DatabaseSync) =>
          database.exec(`
          CREATE TABLE extension_source (id INTEGER PRIMARY KEY);
          CREATE TRIGGER foreign_writer AFTER INSERT ON extension_source
          BEGIN UPDATE monitor_state SET generation = generation + 1; END
        `)
      },
      {
        name: "table:extension_refs",
        mutate: (database: DatabaseSync) =>
          database.exec(`
          CREATE TABLE extension_refs (
            session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT
          )
        `)
      },
      {
        name: "view:extension_sessions",
        mutate: (database: DatabaseSync) =>
          database.exec("CREATE VIEW extension_sessions AS SELECT session_id FROM sessions")
      }
    ] as const

    try {
      for (const [index, testCase] of cases.entries()) {
        const filename = join(directory, `changed-${index}.db`)
        createSchemaFile(filename, testCase.mutate)
        const result = await Effect.runPromiseExit(
          useInitializedDatabase(filename, () => Effect.succeed(undefined))
        )
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          const error = Cause.squash(result.cause)
          expect(error).toBeInstanceOf(StorageStartupError)
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
