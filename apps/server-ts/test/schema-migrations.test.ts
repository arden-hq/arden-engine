import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { RuntimeRunStatus } from "@arden-hq/protocol"
import type { AutomationRunStatus } from "@arden-hq/protocol/automations"
import { ACTIVE_RUN_STATUSES } from "@arden-hq/protocol/runs"
import { AutomationRunStatusSchema } from "@arden-hq/protocol/effect/automations"
import { RuntimeRunStatusSchema } from "@arden-hq/protocol/effect/common"
import { Cause, Effect, Exit, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import {
  BASELINE_VERSION,
  LATEST_SCHEMA_VERSION,
  migrations,
  type Migration
} from "../src/persistence/migrations/index.js"
import {
  MigrationError,
  pendingMigrationSteps,
  planMigrations
} from "../src/persistence/migrations/runner.js"
import {
  buildReferenceSchemaManifest,
  readSchemaManifest,
  schemaIdentity
} from "../src/persistence/schema/manifest.js"
import { migrateAtStartup } from "../src/persistence/sqlite/release-safety.js"
import { diagnosticsLayer, type MigrationProgress } from "../src/runtime/diagnostics.js"
import { releasedMigrationSql } from "./fixtures/migration-sql-pins.js"

const runMigrations = (
  database: DatabaseSync,
  plan: Parameters<typeof pendingMigrationSteps>[0],
  list: ReadonlyArray<Migration> = migrations
): void => {
  try {
    for (const step of pendingMigrationSteps(plan, list)) step.run(database)
  } finally {
    database.exec("PRAGMA foreign_keys = ON")
  }
}

let directory = ""
let filename = ""
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "arden-migrations-"))
  filename = join(directory, "arden.db")
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const withDatabase = <A>(use: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(filename)
  try {
    return use(database)
  } finally {
    database.close()
  }
}

const createBaseline = (version: 0 | 1): void =>
  withDatabase((database) => {
    database.exec("PRAGMA journal_mode = WAL")
    for (const statement of baselineStatements) database.exec(statement)
    database.exec(`PRAGMA user_version = ${version}`)
    database.exec(`INSERT INTO sessions (session_id, public_ref, name, started_at, last_activity)
      VALUES ('kept', 'kept-ref', 'Kept', '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z')`)
  })

const snapshot = (database: DatabaseSync) => ({
  version: database.prepare("PRAGMA user_version").get(),
  schema: readSchemaManifest(database),
  sessions: database.prepare("SELECT session_id, name FROM sessions").all()
})

const recording = (database: DatabaseSync, log: string[]): DatabaseSync =>
  new Proxy(database, {
    get: (target, key) => {
      if (key === "exec")
        return (text: string) => {
          log.push(text)
          target.exec(text)
        }
      if (key === "prepare")
        return (text: string) => {
          log.push(text)
          return target.prepare(text)
        }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    }
  })

const digest = (texts: ReadonlyArray<string>): string =>
  createHash("sha256").update(JSON.stringify(texts)).digest("hex")

const renderedMigrationSql = (): Readonly<Record<number, string>> => {
  const database = new DatabaseSync(":memory:")
  try {
    for (const statement of baselineStatements) database.exec(statement)
    database.exec(`PRAGMA user_version = ${BASELINE_VERSION}`)
    const logs = new Map(migrations.map((migration) => [migration.version, [] as string[]]))
    const recorded = migrations.map((migration): Migration => ({
      ...migration,
      up: (target) => migration.up(recording(target, logs.get(migration.version) ?? []))
    }))
    runMigrations(
      database,
      { kind: "pending", from: BASELINE_VERSION, bridge: undefined },
      recorded
    )
    return Object.fromEntries([
      [BASELINE_VERSION, digest(baselineStatements)],
      ...[...logs].map(([version, log]) => [version, digest(log)])
    ])
  } finally {
    database.close()
  }
}

describe("schema migrations", () => {
  it("every migration runs the SQL pinned for it", () => {
    expect(renderedMigrationSql()).toEqual(releasedMigrationSql)
  })

  it("the baseline plus every migration builds exactly the schema sections declare", () => {
    const database = new DatabaseSync(":memory:")
    try {
      for (const statement of baselineStatements) database.exec(statement)
      database.exec("PRAGMA user_version = 1")
      runMigrations(database, { kind: "pending", from: 1, bridge: undefined })
      const migrated = new Map(
        readSchemaManifest(database).map((row) => [schemaIdentity(row), row])
      )
      const declared = new Map(
        buildReferenceSchemaManifest().map((row) => [schemaIdentity(row), row])
      )
      const differences = [...new Set([...migrated.keys(), ...declared.keys()])]
        .filter((identity) => migrated.get(identity)?.sql !== declared.get(identity)?.sql)
        .map((identity) => ({
          identity,
          migrated: migrated.get(identity)?.sql,
          declared: declared.get(identity)?.sql
        }))
      expect(differences).toEqual([])
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: LATEST_SCHEMA_VERSION
      })
    } finally {
      database.close()
    }
  })

  it("records a pre-migration database already at the baseline shape, then migrates it", async () => {
    createBaseline(0)
    const before = withDatabase((database) => snapshot(database))

    expect(Exit.isSuccess(await Effect.runPromiseExit(migrateAtStartup(filename)))).toBe(true)

    const after = withDatabase((database) => snapshot(database))
    expect(after).toEqual({
      ...before,
      version: { user_version: LATEST_SCHEMA_VERSION },
      schema: buildReferenceSchemaManifest()
    })
    expect(withDatabase((database) => planMigrations(database))).toEqual({ kind: "current" })
    expect(await readdir(directory)).not.toContain("backups")
  })

  it("rolls back a failing migration, keeping every earlier one", () => {
    createBaseline(1)
    const fixtures: ReadonlyArray<Migration> = [
      {
        version: 2,
        name: "adds_notes",
        up: (database) => database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)")
      },
      {
        version: 3,
        name: "breaks_midway",
        up: (database) => {
          database.exec("CREATE TABLE doomed (id INTEGER PRIMARY KEY)")
          database.exec("UPDATE sessions SET name = 'Changed'")
          throw new Error("deliberate")
        }
      }
    ]
    const beforeThree = withDatabase((database) => {
      runMigrations(database, { kind: "pending", from: 1, bridge: undefined }, fixtures.slice(0, 1))
      return snapshot(database)
    })

    const failure = withDatabase((database) => {
      const plan = planMigrations(database, fixtures)
      if (plan.kind !== "pending") throw new Error(`unexpected ${plan.kind}`)
      try {
        runMigrations(database, plan, fixtures)
        return undefined
      } catch (cause) {
        return cause
      }
    })

    expect(failure).toBeInstanceOf(MigrationError)
    expect(failure).toMatchObject({ version: 3, message: expect.stringContaining("deliberate") })
    expect(withDatabase((database) => snapshot(database))).toEqual(beforeThree)
    expect(beforeThree.version).toEqual({ user_version: 2 })
  })

  it("refuses a migration that breaks a reference, however it declares its foreign keys", () => {
    createBaseline(1)
    const parents: Migration = {
      version: 2,
      name: "adds_parents",
      foreignKeys: { kind: "enforced" },
      up: (database) => {
        database.exec("CREATE TABLE parents (id INTEGER PRIMARY KEY)")
        database.exec(
          "CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE)"
        )
        database.exec("INSERT INTO parents (id) VALUES (1), (2)")
        database.exec("INSERT INTO children (id, parent_id) VALUES (10, 1), (20, 2)")
      }
    }
    const dangling: Migration = {
      version: 3,
      name: "writes_dangling",
      foreignKeys: { kind: "enforced" },
      up: (database) => database.exec("INSERT INTO children (id, parent_id) VALUES (30, 99)")
    }
    const lossyRebuild: Migration = {
      version: 3,
      name: "rebuilds_parents_losing_a_row",
      foreignKeys: { kind: "rebuilds", tables: ["parents"] },
      up: (database) => {
        database.exec("CREATE TABLE parents_next (id INTEGER PRIMARY KEY)")
        database.exec("INSERT INTO parents_next (id) SELECT id FROM parents WHERE id = 1")
        database.exec("DROP TABLE parents")
        database.exec("ALTER TABLE parents_next RENAME TO parents")
      }
    }
    const run = (list: ReadonlyArray<Migration>) =>
      withDatabase((database) => {
        const plan = planMigrations(database, list)
        if (plan.kind !== "pending") throw new Error(`unexpected ${plan.kind}`)
        try {
          runMigrations(database, plan, list)
          return undefined
        } catch (cause) {
          return cause
        }
      })
    const children = () =>
      withDatabase((database) => database.prepare("SELECT id FROM children ORDER BY id").all())

    expect(run([parents])).toBeUndefined()
    expect(run([parents, dangling])).toBeInstanceOf(MigrationError)
    expect(run([parents, lossyRebuild])).toMatchObject({
      version: 3,
      message: expect.stringContaining("foreign key check failed")
    })
    expect(children()).toEqual([{ id: 10 }, { id: 20 }])
    expect(withDatabase((database) => database.prepare("PRAGMA user_version").get())).toEqual({
      user_version: 2
    })
  })

  it("refuses a database a newer build wrote, untouched", async () => {
    createBaseline(1)
    withDatabase((database) => database.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`))
    const before = withDatabase((database) => snapshot(database))

    const result = await Effect.runPromiseExit(migrateAtStartup(filename))

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.squash(result.cause)).toMatchObject({ operation: "open_newer_data" })
    }
    expect(withDatabase((database) => snapshot(database))).toEqual(before)
  })

  it("never migrates while another connection has the database open", async () => {
    createBaseline(0)
    const other = new DatabaseSync(filename)
    other.prepare("SELECT count(*) FROM sessions").get()
    try {
      const result = await Effect.runPromiseExit(migrateAtStartup(filename))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toMatchObject({
          operation: "initialize",
          message: "Another Arden process has this data open; quit it and start Arden again"
        })
      }
    } finally {
      other.close()
    }
    expect(withDatabase((database) => planMigrations(database))).toMatchObject({ from: 0 })
  })

  it("lets the host's port send schema_conversion_started and each step before it blocks", async () => {
    createBaseline(0)
    const log: Array<string> = []
    const port = (phase: string) => {
      log.push(`posted ${phase}`)
      setImmediate(() => {
        const version = withDatabase((database) => snapshot(database).version)
        log.push(version?.user_version === 0 ? "sent" : "sent after migrating began")
      })
    }
    const steps: Array<string> = []
    const stepPort = ({ step, total, name }: MigrationProgress) => {
      steps.push(`posted ${step}/${total} ${name}`)
      setImmediate(() => steps.push(`sent ${step}`))
    }
    const result = await Effect.runPromiseExit(
      migrateAtStartup(filename).pipe(
        Effect.provide(
          diagnosticsLayer({ startupPhase: port, migration: stepPort, operational: () => {} })
        )
      )
    )
    expect(Exit.isSuccess(result)).toBe(true)
    expect(log).toEqual(["posted schema_conversion_started", "sent"])
    const names = ["baseline", ...migrations.map((migration) => migration.name)]
    expect(steps).toEqual(
      names.flatMap((name, index) => [
        `posted ${index + 1}/${names.length} ${name}`,
        `sent ${index + 1}`
      ])
    )
    expect(existsSync(join(directory, "backups"))).toBe(false)
  })

  it("stores every status a Task attempt's chat run can take as one the run readers decode", () => {
    createBaseline(1)
    const stored = withDatabase((database) => {
      runMigrations(database, { kind: "pending", from: 1, bridge: undefined })
      return Object.fromEntries(
        RuntimeRunStatusSchema.literals.map((status) => {
          const runId = `run-${status}`
          database.exec(`INSERT INTO chat_runs
              (run_id, session_id, status, started_at, updated_at, assistant_message_id)
            VALUES ('${runId}', 'kept', 'pending', '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z', 'm-${status}')`)
          database.exec(`INSERT INTO automation_runs (chat_run_id, started_at)
            VALUES ('${runId}', '2026-09-29T00:00:00Z')`)
          const ended = ["pending", "running"].includes(status)
            ? "ended_at = NULL"
            : "ended_at = '2026-09-29T00:01:00Z', updated_at = '2026-09-29T00:01:00Z'"
          const stop = status === "interrupted" ? ", stop_reason = 'server_restart'" : ""
          database.exec(
            `UPDATE chat_runs SET status = '${status}', ${ended}${stop} WHERE run_id = '${runId}'`
          )
          const row = database
            .prepare("SELECT status FROM automation_runs WHERE chat_run_id = ?")
            .get(runId)
          return [status, Schema.decodeUnknownSync(AutomationRunStatusSchema)(row?.status)]
        })
      )
    })
    const expected: Record<RuntimeRunStatus, AutomationRunStatus> = {
      pending: "running",
      running: "running",
      interrupted: "interrupted",
      error: "failed",
      cancelled: "cancelled",
      completed: "completed"
    }
    expect(stored).toEqual(expected)
  })

  it("converts stored chat statuses, keeps the id counter, then refuses values the readers reject", () => {
    createBaseline(1)
    const insertRun = (database: DatabaseSync, id: number, status: string, chatRunId: string) =>
      database.exec(`INSERT INTO automation_runs (id, chat_run_id, started_at, status)
        VALUES (${id}, '${chatRunId}', '2026-09-29T00:00:00Z', '${status}')`)
    const after = withDatabase((database) => {
      database.exec(`INSERT INTO chat_runs
          (run_id, session_id, status, started_at, updated_at, ended_at, assistant_message_id)
        VALUES ('done', 'kept', 'completed', '2026-09-29T00:00:00Z', '2026-09-29T00:01:00Z',
          '2026-09-29T00:01:00Z', 'm-done')`)
      insertRun(database, 1, "error", "gone-1")
      insertRun(database, 2, "pending", "done")
      insertRun(database, 3, "backgrounded", "gone-3")
      insertRun(database, 4, "interrupted", "gone-4")
      insertRun(database, 5, "completed", "gone-5")
      insertRun(database, 50, "failed", "gone-50")
      database.exec("DELETE FROM automation_runs WHERE id = 50")
      runMigrations(database, { kind: "pending", from: 1, bridge: undefined })
      return {
        runs: database.prepare("SELECT id, status FROM automation_runs ORDER BY id").all(),
        counter: database
          .prepare("SELECT seq FROM sqlite_sequence WHERE name LIKE 'automation_runs%'")
          .all()
      }
    })
    expect(after).toEqual({
      runs: [
        { id: 1, status: "failed" },
        { id: 2, status: "completed" },
        { id: 3, status: "running" },
        { id: 4, status: "interrupted" },
        { id: 5, status: "completed" }
      ],
      counter: [{ seq: 50 }]
    })
    withDatabase((database) => {
      expect(() => insertRun(database, 51, "error", "late")).toThrow(/CHECK constraint failed/)
      expect(() =>
        database.exec("UPDATE automation_runs SET status = 'blocked' WHERE id = 5")
      ).toThrow(/CHECK constraint failed/)
      expect(() =>
        database.exec(`INSERT INTO session_messages
            (session_id, message_id, seq, role, message_json, created_at)
          VALUES ('kept', 'm1', 1, 'narrator', '{}', '2026-09-29T00:00:00Z')`)
      ).toThrow(/Unknown transcript message role/)
    })
  })

  it("archives an archived Space's own conversation with it, and still refuses that alone", () => {
    createBaseline(1)
    const at = "2026-10-20T00:00:00Z"
    const archived = withDatabase((database) => {
      const plan = { kind: "pending", from: 1, bridge: undefined } as const
      runMigrations(
        database,
        plan,
        migrations.filter((migration) => migration.version <= 112)
      )
      database.exec(`INSERT INTO desks (desk_id, name, name_key, created_at, updated_at)
        VALUES ('old', 'Old', 'old', '${at}', '${at}'), ('open', 'Open', 'open', '${at}', '${at}')`)
      const session = database.prepare(`INSERT INTO sessions
        (session_id, public_ref, started_at, last_activity, session_type, desk_id)
        VALUES (?, ?, '${at}', '${at}', 'chat', ?)`)
      for (const [id, space] of [
        ["old-main", "old"],
        ["old-side", "old"],
        ["open-main", "open"]
      ] as const)
        session.run(id, id, space)
      database.exec(`INSERT INTO desk_conversations (desk_id, session_id)
        VALUES ('old', 'old-main'), ('open', 'open-main')`)
      database.exec(`UPDATE desks SET archived_at = '${at}' WHERE desk_id = 'old'`)
      runMigrations(database, { kind: "pending", from: 112, bridge: undefined })
      return database
        .prepare(
          "SELECT session_id, archived_at FROM sessions WHERE space_id IS NOT NULL ORDER BY session_id"
        )
        .all()
    })
    expect(archived).toEqual([
      { session_id: "old-main", archived_at: at },
      { session_id: "old-side", archived_at: at },
      { session_id: "open-main", archived_at: null }
    ])
    withDatabase((database) => {
      expect(() =>
        database.exec(`UPDATE sessions SET archived_at = '${at}' WHERE session_id = 'open-main'`)
      ).toThrow(/cannot be moved or archived separately/)
    })
  })

  it("gives every command Arden may always run an id, with no invented grant time", () => {
    createBaseline(1)
    const rows = withDatabase((database) => {
      database.exec(`INSERT INTO command_permissions (executable_path, argument_prefix_json, display_prefix)
        VALUES ('/usr/bin/git', '["status"]', 'git status …'), ('/bin/ls', '[]', 'ls …')`)
      runMigrations(
        database,
        { kind: "pending", from: 1, bridge: undefined },
        migrations.filter((migration) => migration.version <= 3)
      )
      return database
        .prepare(
          "SELECT permission_id, display_prefix, granted_at FROM command_permissions ORDER BY display_prefix"
        )
        .all()
    })
    expect(rows).toEqual([
      {
        permission_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        display_prefix: "git status …",
        granted_at: null
      },
      {
        permission_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        display_prefix: "ls …",
        granted_at: null
      }
    ])
  })
})
