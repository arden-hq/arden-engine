import { DatabaseSync } from "node:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "vitest"
import { databaseSchema } from "../src/persistence/schema/database.js"
import { searchSchemaSection } from "../src/persistence/schema/search.js"
import { LATEST_SCHEMA_VERSION } from "../src/persistence/migrations/index.js"
import { StorageStartupError } from "../src/persistence/service.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"
import { rebuildSessionTurns } from "../src/persistence/sqlite/turns.js"
import { diagnosticsLayer } from "../src/runtime/diagnostics.js"
import type { OperationalEvent } from "@arden-hq/protocol/daemon"

const names = (
  database: DatabaseSync,
  type: "table" | "index" | "trigger"
): ReadonlyArray<string> =>
  database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = ? AND name NOT GLOB 'sqlite_*' ORDER BY name"
    )
    .all(type)
    .map((row) => String(row.name))

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
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>,
  events: Array<OperationalEvent> = []
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
              operational: (event) => events.push(event)
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
                { role: "user", content: "Inspect it", turn_id: "user-1" }
              ],
              [
                "assistant-1",
                1,
                "assistant",
                null,
                { role: "assistant", content: null, turn_id: "user-1" }
              ],
              [
                "tool-1",
                2,
                "tool",
                null,
                { role: "tool", tool_call_id: "call-1", content: "ok", turn_id: "user-1" }
              ],
              [
                "media-1",
                3,
                "user",
                "tool-media:call-1",
                { role: "user", is_meta: true, content: [], turn_id: "user-1" }
              ],
              [
                "assistant-2",
                4,
                "assistant",
                null,
                { role: "assistant", content: "Done", turn_id: "user-1" }
              ],
              [
                "user-focus",
                5,
                "user",
                "focus:g-1:run-1",
                { role: "user", is_meta: true, content: "Continue", turn_id: "user-focus" }
              ],
              [
                "assistant-focus",
                6,
                "assistant",
                null,
                { role: "assistant", content: "More", turn_id: "user-focus" }
              ],
              ["user-2", 7, "user", "user-2", { role: "user", content: "Next", turn_id: "user-2" }],
              [
                "assistant-3",
                8,
                "assistant",
                null,
                { role: "assistant", content: "Next done", turn_id: "user-2" }
              ]
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

  it("creates the exact baseline and enforces its critical ownership constraints", () => {
    const database = new DatabaseSync(":memory:")
    try {
      database.exec("PRAGMA foreign_keys = ON")
      database.exec("BEGIN IMMEDIATE")
      for (const statement of databaseSchema.statements) database.exec(statement)
      database.exec("COMMIT")

      expect(names(database, "table")).toEqual([...databaseSchema.tables].sort())
      expect(names(database, "index")).toEqual([...databaseSchema.indexes].sort())
      expect(names(database, "trigger")).toEqual([...databaseSchema.triggers].sort())
      expect(
        database
          .prepare("SELECT name FROM pragma_table_info('scheduled_tasks') ORDER BY cid")
          .all()
          .map((row) => row.name)
      ).toEqual([
        "task_id",
        "automation_ref",
        "name",
        "description",
        "description_source",
        "prompt",
        "model",
        "context_mode",
        "triggers",
        "enabled",
        "created_at",
        "last_run_at",
        "next_run_at",
        "last_result",
        "running_since",
        "auto_approve",
        "handler",
        "builtin",
        "cooldown_minutes",
        "thread_id",
        "idempotency_key",
        "idempotency_scope",
        "tool_scope",
        "triggers_source",
        "purpose",
        "owner_space_id",
        "owner_task_id",
        "followup_generation",
        "trigger_last_id",
        "prompt_author",
        "instruction_revision_id",
        "paused_at"
      ])
      database.exec(`INSERT INTO scheduled_tasks
        (task_id, automation_ref, prompt, triggers, created_at, tool_scope, purpose)
        VALUES ('browser-scope', 'browser-scope-ref', 'Prompt', '[]',
          '2026-08-20T00:00:00+00:00', 'browser', 'system')`)
      expect(() =>
        database.exec(`INSERT INTO scheduled_tasks
        (task_id, automation_ref, prompt, triggers, created_at, tool_scope)
        VALUES ('bad-scope', 'bad-scope-ref', 'Prompt', '[]',
          '2026-08-20T00:00:00+00:00', 'unsupported')`)
      ).toThrow()
      database.exec(`INSERT INTO automation_deliveries
        (delivery_id, task_id, delivered_at, subject, body, destinations)
        VALUES ('${"a".repeat(64)}', 'browser-scope', '2026-08-24T05:00:00Z',
          'Subject', 'Body', '["email"]')`)
      expect(() =>
        database.exec(`INSERT INTO automation_deliveries
        (delivery_id, task_id, delivered_at, subject, body, destinations)
        VALUES ('short', 'browser-scope', '2026-08-24T05:00:00Z',
          'Subject', 'Body', '[]')`)
      ).toThrow()
      expect(() =>
        database.exec(`INSERT INTO automation_deliveries
        (delivery_id, task_id, delivered_at, subject, body, destinations)
        VALUES ('${"b".repeat(64)}', 'browser-scope', '2026-08-24T05:00:00Z',
          'Subject', 'Body', '{}')`)
      ).toThrow()
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

      expect(names(database, "table")).not.toContain("wiki_embedding_chunks")

      database.exec(`INSERT INTO journal_streams
        (stream_id, head_sequence, retained_from_sequence)
        VALUES ('session-1', 1, NULL)`)
      expect(() =>
        database.exec(`INSERT INTO journal_records
        (stream_id, sequence, event_type, data_json, attributes_json, created_at)
        VALUES ('session-1', 0, 'RUN_STARTED', '{}', '{}', '2026-08-20T00:00:00+00:00')`)
      ).toThrow()
      expect(() =>
        database.exec(`INSERT INTO journal_streams
        (stream_id, head_sequence, retained_from_sequence)
        VALUES ('session-2', 1, 2)`)
      ).toThrow()
      expect(() =>
        database.exec(`INSERT INTO session_event_checkpoints
        (session_id, checkpoint_seq)
        VALUES ('missing-session', 0)`)
      ).toThrow()
      expect(() =>
        database.exec(`INSERT INTO chat_runs
        (run_id, session_id, status, started_at, updated_at, ended_at)
        VALUES ('run-1', 'session-1', 'running',
          '2026-08-20T00:00:00+00:00', '2026-08-20T00:00:01+00:00',
          '2026-08-20T00:00:01+00:00')`)
      ).toThrow()
      expect(() =>
        database.exec(`INSERT INTO chat_idempotency_keys
        (session_id, client_id, request_hash, status, created_at, updated_at)
        VALUES ('session-1', 'client-1', 'hash-1', 'queued',
          '2026-08-20T00:00:00+00:00', '2026-08-20T00:00:00+00:00')`)
      ).toThrow()
      expect(() =>
        database.exec(`INSERT INTO scheduled_tasks
        (task_id, automation_ref, prompt, triggers, created_at, purpose)
        VALUES ('review', 'review-ref', 'Review', '[]', '2026-08-20T00:00:00+00:00',
          'space_review')`)
      ).toThrow()
    } finally {
      database.close()
    }
  })

  it("preflights the file-backed storage mode without rewriting populated databases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-persistence-schema-"))
    const freshFilename = join(directory, "fresh.db")
    const modeZeroDirectory = await mkdtemp(join(directory, "mode-zero-"))
    const modeZeroFilename = join(modeZeroDirectory, "mode-zero.db")
    const storageMode = (filename: string) => {
      const database = new DatabaseSync(filename)
      try {
        return {
          journalMode: database.prepare("PRAGMA journal_mode").get(),
          autoVacuum: database.prepare("PRAGMA auto_vacuum").get(),
          rows: database
            .prepare(
              "SELECT space_id AS id, name FROM spaces UNION ALL SELECT session_id, name FROM sessions"
            )
            .all()
        }
      } finally {
        database.close()
      }
    }

    try {
      await Effect.runPromise(
        useInitializedDatabase(freshFilename, (sql) =>
          sql.unsafe(`INSERT INTO sessions (session_id, public_ref, name, started_at, last_activity)
          VALUES ('survives-reopen', 'survives-reopen-ref', 'Durable',
            '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')`)
        )
      )
      expect(storageMode(freshFilename)).toEqual({
        journalMode: { journal_mode: "wal" },
        autoVacuum: { auto_vacuum: 2 },
        rows: [{ id: "survives-reopen", name: "Durable" }]
      })

      createSchemaFile(modeZeroFilename, (database) => {
        database.exec(`INSERT INTO spaces (space_id, name, name_key, created_at, updated_at)
          VALUES ('must-not-change', 'Untouched', 'untouched',
            '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')`)
        expect(database.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 })
      })

      await Effect.runPromise(useInitializedDatabase(modeZeroFilename, () => Effect.void))
      expect(storageMode(modeZeroFilename)).toEqual({
        journalMode: { journal_mode: "wal" },
        autoVacuum: { auto_vacuum: 0 },
        rows: [{ id: "must-not-change", name: "Untouched" }]
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
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
        expect((error as StorageStartupError).message).toContain("SQLite schema is missing")
        expect((error as StorageStartupError).message).toContain("table:session_queued_messages")
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

  it("accepts only detached foreign tables and their indexes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-schema-foreign-"))
    const filename = join(directory, "foreign.db")
    try {
      createSchemaFile(filename, (database) =>
        database.exec(`
        CREATE TABLE extension_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX idx_extension_records_value ON extension_records(value);
      `)
      )
      const events: Array<OperationalEvent> = []
      const result = await Effect.runPromiseExit(
        useInitializedDatabase(filename, () => Effect.succeed("booted"), events)
      )
      expect(result).toEqual(Exit.succeed("booted"))
      expect(events).toEqual([
        {
          version: 1,
          code: "storage.schema_drift",
          severity: "warning",
          occurredAt: expect.any(String),
          cause: null,
          objectType: "index",
          objectName: "idx_extension_records_value",
          verdict: "foreign_warning"
        },
        {
          version: 1,
          code: "storage.schema_drift",
          severity: "warning",
          occurredAt: expect.any(String),
          cause: null,
          objectType: "table",
          objectName: "extension_records",
          verdict: "foreign_warning"
        }
      ])
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
          expect((error as StorageStartupError).message).toContain(testCase.name)
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
