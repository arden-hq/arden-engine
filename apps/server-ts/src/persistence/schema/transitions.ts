import type { DatabaseSync } from "node:sqlite"
import { JOURNAL_HEAD_SEQUENCE_SQL } from "@arden-hq/journal/effect"
import { SESSION_LIFECYCLE_STREAM_ID } from "../sessions/events.js"
import {
  classifySchemaManifest,
  readForeignTableReferences,
  readSchemaManifest,
  schemaIdentity,
  schemaManifestFingerprint,
  type SchemaManifestRow
} from "./manifest.js"
import { communicationSequenceColumnSql } from "./sections/communication.js"
import { schemaCleanupPriorRows } from "./priors/schema-cleanup.js"

interface SchemaTransition {
  readonly source: string
  readonly fingerprint: string
  readonly prior: (next: ReadonlyArray<SchemaManifestRow>) => ReadonlyArray<SchemaManifestRow>
  readonly convert: (database: DatabaseSync, next: ReadonlyArray<SchemaManifestRow>) => void
  readonly discards: ReadonlyArray<string>
}

const sessionLayoutPriorSessionsSql = `CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      public_ref TEXT NOT NULL UNIQUE,
      started_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      last_accessed_at TEXT,
      messages TEXT,
      metadata TEXT,
      name TEXT,
      archived_at TEXT,
      session_type TEXT NOT NULL DEFAULT 'chat' CHECK(session_type IN ('chat', 'channel', 'agent')),
      origin_automation_id TEXT,
      parent_session_id TEXT,
      parent_run_id TEXT,
      parent_tool_call_id TEXT,
      desk_id TEXT REFERENCES desks(desk_id) ON DELETE SET NULL,
      chat_model TEXT,
      context_generation INTEGER NOT NULL DEFAULT 0,
      active_message_count INTEGER NOT NULL DEFAULT 0,
      parent_message_id TEXT,
      has_unread INTEGER NOT NULL DEFAULT 0 CHECK(has_unread IN (0, 1)), visible_message_count INTEGER NOT NULL DEFAULT 0,
      CHECK(
        (session_type = 'agent'
          AND parent_session_id IS NOT NULL
          AND parent_run_id IS NOT NULL
          AND parent_tool_call_id IS NOT NULL
          AND parent_message_id IS NULL)
        OR
        (session_type <> 'agent'
          AND parent_run_id IS NULL
          AND parent_tool_call_id IS NULL)
      )
    )`

/** SQLite splices an added column's definition into the stored CREATE TABLE text. */
const visibleMessageCountColumn = "visible_message_count INTEGER NOT NULL DEFAULT 0"

const communicationPriorAutomationDeliveriesSql = `CREATE TABLE automation_deliveries (
      delivery_id TEXT PRIMARY KEY
        CHECK(length(delivery_id) = 64 AND delivery_id NOT GLOB '*[^0-9a-f]*'),
      task_id TEXT REFERENCES scheduled_tasks(task_id) ON DELETE SET NULL,
      delivered_at TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      payload TEXT CHECK(payload IS NULL OR json_valid(payload)),
      status TEXT NOT NULL DEFAULT 'delivered' CHECK(status IN ('pending', 'delivered', 'discarded')),
      created_at TEXT NOT NULL DEFAULT '',
      destinations TEXT NOT NULL
        CHECK(json_valid(destinations) AND json_type(destinations) = 'array')
    , attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0), next_attempt_at TEXT, last_error TEXT)`

const deliveryReliabilityPriorAutomationDeliveriesSql = `CREATE TABLE automation_deliveries (
      delivery_id TEXT PRIMARY KEY
        CHECK(length(delivery_id) = 64 AND delivery_id NOT GLOB '*[^0-9a-f]*'),
      task_id TEXT REFERENCES scheduled_tasks(task_id) ON DELETE SET NULL,
      delivered_at TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      payload TEXT CHECK(payload IS NULL OR json_valid(payload)),
      status TEXT NOT NULL DEFAULT 'delivered' CHECK(status IN ('pending', 'delivered', 'discarded')),
      created_at TEXT NOT NULL DEFAULT '',
      destinations TEXT NOT NULL
        CHECK(json_valid(destinations) AND json_type(destinations) = 'array')
    )`

const deliveryReliabilityPriorPendingIndexSql = `CREATE INDEX idx_automation_deliveries_pending
      ON automation_deliveries(status, created_at, delivery_id)`

const automationKindColumn =
  "kind TEXT NOT NULL DEFAULT 'automation' CHECK(kind IN ('automation', 'agent')),"

const automationKindCheck =
  "CHECK((kind = 'agent') = (purpose IN ('desk_review', 'task_execution'))),"

const schemaTransitions = [
  {
    source: "automation_kind",
    fingerprint: "5be45d67b8df5aaa8478ed193b076d4a33085b5d286f611f01a63d9dcf06ace1",
    discards: ["scheduled_tasks.kind"],
    prior: (next) =>
      next.map((row) =>
        schemaIdentity(row) === "table:scheduled_tasks" && row.sql !== null
          ? {
              ...row,
              sql: row.sql
                .replace(
                  "cooldown_minutes INTEGER,\n",
                  `cooldown_minutes INTEGER,\n      ${automationKindColumn}\n`
                )
                .replace(
                  "context_mode IN ('fresh', 'continue'))),\n",
                  `context_mode IN ('fresh', 'continue'))),\n      ${automationKindCheck}\n`
                )
            }
          : row
      ),
    convert: (database, next) => rebuildTable(database, next, "scheduled_tasks")
  },
  {
    source: "one_automation_chat",
    fingerprint: "2393b02daa1f0ad45decc0e455e9c8b3be1bba49404f5b611aaa5302b3dbffc3",
    discards: [
      "scheduled_tasks.execution_session_id",
      "scheduled_tasks.owner_desk_id",
      "sessions.desk_id"
    ],
    prior: (next) =>
      next.map((row) =>
        schemaIdentity(row) === "table:scheduled_tasks" && row.sql !== null
          ? {
              ...row,
              sql: row.sql
                .replace("thread_id TEXT,", "thread_id TEXT,\n      execution_session_id TEXT,")
                .replace(
                  "CHECK(purpose != 'user_automation' OR (thread_id IS NOT NULL AND context_mode IN ('fresh', 'continue'))),",
                  "CHECK(purpose != 'user_automation' OR execution_session_id IS NOT NULL),"
                )
                .replace(
                  "(purpose = 'user_automation' AND owner_desk_id IS NULL AND owner_task_id IS NULL) OR",
                  "(purpose = 'user_automation' AND owner_task_id IS NULL) OR"
                )
            }
          : row
      ),
    convert: (database, next) => {
      rebuildTable(database, next, "scheduled_tasks", {
        owner_desk_id: "CASE WHEN purpose = 'user_automation' THEN NULL ELSE owner_desk_id END"
      })
      database.exec(`
        WITH RECURSIVE own(session_id) AS (
          SELECT session.session_id FROM sessions AS session
          JOIN scheduled_tasks AS automation ON automation.task_id = session.origin_automation_id
          WHERE session.session_type = 'channel' AND automation.purpose = 'user_automation'
          UNION
          SELECT child.session_id FROM sessions AS child
          JOIN own ON child.parent_session_id = own.session_id
        )
        UPDATE sessions SET desk_id = NULL
        WHERE desk_id IS NOT NULL AND session_id IN (SELECT session_id FROM own)
      `)
    }
  },
  {
    source: "fork_context_mode",
    fingerprint: "f2045418109547b8211f136ace05a0f659731ec1b74e9531405d19c4079abe56",
    discards: [],
    prior: (next) =>
      next.map((row) => {
        if (row.type !== "table" || row.sql === null) return row
        if (row.name !== "scheduled_tasks" && row.name !== "automation_runs") return row
        const sql = row.sql
          .replace("('fresh', 'continue', 'fork')", "('fresh', 'continue')")
          .replace(", 'memory_capture', 'chat_summary')", ", 'memory_capture')")
        return { ...row, sql }
      }),
    convert: (database, next) => {
      rebuildTable(database, next, "scheduled_tasks")
      rebuildTable(database, next, "automation_runs")
    }
  },
  {
    source: "continuity_summaries",
    fingerprint: "093d6ef6262fd2266413536b809d540f2a5734f89597e4a4ab61f91c5698c6fa",
    discards: [],
    prior: (next) =>
      next.filter(
        (row) => !["table:chat_summaries", "table:desk_summaries"].includes(schemaIdentity(row))
      ),
    convert: (database, next) => {
      createFrom(database, next, "table:chat_summaries")
      createFrom(database, next, "table:desk_summaries")
    }
  },
  {
    source: "task_item_index",
    fingerprint: "2c08f83d22bd19e45fee8a95f40dd0a6564c2736b8c7d3b42d8890956c251afe",
    discards: [],
    prior: (next) => next.filter((row) => schemaIdentity(row) !== "index:idx_chat_runs_task_item"),
    convert: (database, next) => {
      createFrom(database, next, "index:idx_chat_runs_task_item")
    }
  },
  {
    source: "schema_cleanup",
    fingerprint: "503ca2598f33e8145a2551caf03c18e7e91f694abf4d24a102a827f81a406eb7",
    prior: (next) => withRows(next, schemaCleanupPriorRows),
    discards: [
      "outbox_events",
      "desk_letter_reports",
      "storage_backup_pins",
      "desk_continuity_seen.report_id",
      "desk_continuity_seen.report_revision",
      "storage_settings.backup_retention_days",
      "workflow_attempts.lease_expires_at",
      "scheduled_tasks.kind"
    ],
    convert: (database, next) => {
      database.exec("DROP TABLE outbox_events")
      database.exec("DELETE FROM sqlite_sequence WHERE name = 'outbox_events'")
      rebuildTable(database, next, "desk_continuity_seen")
      database.exec("DROP TABLE desk_letter_reports")
      database.exec("DROP TABLE storage_backup_pins")
      rebuildTable(database, next, "storage_settings")
      rebuildTable(database, next, "scheduled_tasks", {
        kind: "CASE WHEN purpose IN ('desk_review', 'task_execution') THEN 'agent' ELSE 'automation' END"
      })
      rebuildTable(database, next, "workflow_attempts")
    }
  },
  {
    source: "session_layout",
    fingerprint: "99721dc7546e7aebfa159839f78a2de8c4f50c35dc149519ef3af2f64d5e6b20",
    discards: [],
    prior: (next) =>
      next.map((row) =>
        schemaIdentity(row) === "table:sessions"
          ? { ...row, sql: sessionLayoutPriorSessionsSql }
          : row
      ),
    convert: (database, next) => rebuildTable(database, next, "sessions")
  },
  {
    source: "session_list",
    fingerprint: "14828ecc5f2435a6d9d22f64593357c2fac05d3c50a01220803c916d09fa2cbe",
    discards: [],
    prior: (next) =>
      next
        .filter((row) => schemaIdentity(row) !== "index:idx_sessions_list")
        .map((row) =>
          schemaIdentity(row) === "table:sessions" && row.sql !== null
            ? { ...row, sql: row.sql.replace(`, ${visibleMessageCountColumn}`, "") }
            : row
        ),
    convert: (database, next) => {
      database.exec(`ALTER TABLE sessions ADD COLUMN ${visibleMessageCountColumn}`)
      database.exec(`UPDATE sessions SET visible_message_count = (
        SELECT COUNT(*) FROM json_each(messages) AS message
        WHERE json_extract(message.value, '$.role') NOT IN ('system', 'developer'))`)
      createFrom(database, next, "index:idx_sessions_list")
    }
  },
  {
    source: "task_authority",
    fingerprint: "d6d0a1646952286a3f3743c2670c20408c9850f3affe25b1a5683f1aeed6f5fb",
    discards: [],
    prior: (next) => next.filter((row) => !taskAuthorityObjects.includes(schemaIdentity(row))),
    convert: (database, next) => {
      for (const identity of taskAuthorityObjects) createFrom(database, next, identity)
    }
  },
  {
    source: "communication",
    fingerprint: "8a1a34d2a7d7706fe8e880a419f5891398e8d8294c9f512ede0b7dc7036121f1",
    discards: [],
    prior: (next) =>
      next
        .filter((row) => !communicationObjects.includes(schemaIdentity(row)))
        .map((row) =>
          schemaIdentity(row) === "table:automation_deliveries"
            ? { ...row, sql: communicationPriorAutomationDeliveriesSql }
            : row
        ),
    convert: (database, next) => {
      database.exec(communicationSequenceColumnSql)
      for (const identity of communicationObjects) createFrom(database, next, identity)
      database.exec(
        "INSERT INTO communication_sequence_clock(singleton_id, current_sequence) VALUES(1, 0)"
      )
      database
        .prepare(
          `
        INSERT INTO desk_continuity_seen(desk_id, task_events_through, question_changes_through)
        SELECT desk.desk_id,
          COALESCE((SELECT MAX(event.event_id) FROM desk_task_events AS event
            WHERE event.desk_id = desk.desk_id), 0),
          COALESCE(${JOURNAL_HEAD_SEQUENCE_SQL}, 0)
        FROM desks AS desk
      `
        )
        .run(SESSION_LIFECYCLE_STREAM_ID)
    }
  },
  {
    source: "delivery_reliability",
    fingerprint: "f3185583a23aed5a8581a44feae098800f2ac36f9dcc1671b01359f82a190ebb",
    discards: [],
    prior: (next) =>
      next
        .filter((row) => !deliveryReliabilityObjects.includes(schemaIdentity(row)))
        .map((row) => {
          if (schemaIdentity(row) === "table:automation_deliveries") {
            return { ...row, sql: deliveryReliabilityPriorAutomationDeliveriesSql }
          }
          if (schemaIdentity(row) === "index:idx_automation_deliveries_pending") {
            return { ...row, sql: deliveryReliabilityPriorPendingIndexSql }
          }
          return row
        }),
    convert: (database, next) => {
      database.exec(`
        ALTER TABLE automation_deliveries ADD COLUMN
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0);
        ALTER TABLE automation_deliveries ADD COLUMN next_attempt_at TEXT;
        ALTER TABLE automation_deliveries ADD COLUMN last_error TEXT;
        DROP INDEX idx_automation_deliveries_pending;
      `)
      createFrom(database, next, "index:idx_automation_deliveries_pending")
      for (const identity of deliveryReliabilityObjects) createFrom(database, next, identity)
    }
  }
] as const satisfies ReadonlyArray<SchemaTransition>

type SchemaTransitionSource = (typeof schemaTransitions)[number]["source"]

export interface SchemaTransitionPath {
  readonly source: SchemaTransitionSource
  readonly fingerprint: string
  readonly steps: ReadonlyArray<{
    readonly transition: SchemaTransition
    readonly next: ReadonlyArray<SchemaManifestRow>
  }>
}

export const findSchemaTransition = (
  current: ReadonlyArray<SchemaManifestRow>,
  live: ReadonlyArray<SchemaManifestRow>,
  foreignTableReferences: ReadonlyMap<string, ReadonlyArray<string>>
): SchemaTransitionPath | undefined => {
  const steps: Array<SchemaTransitionPath["steps"][number]> = []
  let next = current
  for (const transition of schemaTransitions) {
    const prior = transition.prior(next)
    const fingerprint = schemaManifestFingerprint(prior)
    if (fingerprint !== transition.fingerprint) {
      throw new Error(
        `Schema transition ${transition.source} prior manifest changed: expected ${transition.fingerprint}, got ${fingerprint}`
      )
    }
    steps.unshift({ transition, next })
    if (classifySchemaManifest(prior, live, foreignTableReferences).kind === "current") {
      return { source: transition.source, fingerprint, steps }
    }
    next = prior
  }
  return undefined
}

export const applySchemaTransitions = (
  database: DatabaseSync,
  path: SchemaTransitionPath
): void => {
  for (const step of path.steps) {
    step.transition.convert(database, step.next)
    const live = readSchemaManifest(database)
    const verdict = classifySchemaManifest(
      step.next,
      live,
      readForeignTableReferences(database, step.next, live)
    )
    if (verdict.kind !== "current") {
      throw new Error(
        `Schema transition ${step.transition.source} did not reach its next manifest: ${JSON.stringify(verdict)}`
      )
    }
  }
}

const taskAuthorityObjects: ReadonlyArray<string> = [
  "table:desk_task_proposals",
  "index:idx_task_proposals_desk_status",
  "table:focus_choices",
  "index:idx_focus_choices_desk_status"
]

const communicationObjects: ReadonlyArray<string> = [
  "index:idx_automation_deliveries_communication_sequence",
  "index:idx_automation_deliveries_communication_desk",
  "table:communication_sequence_clock",
  "table:desk_letter_reports",
  "index:idx_desk_letter_reports_current",
  "table:desk_continuity_seen"
]

const deliveryReliabilityObjects: ReadonlyArray<string> = [
  "table:delivery_incidents",
  "index:idx_delivery_incidents_created"
]

const withRows = (
  next: ReadonlyArray<SchemaManifestRow>,
  rows: ReadonlyArray<SchemaManifestRow>
): ReadonlyArray<SchemaManifestRow> => {
  const replaced = new Set(rows.map(schemaIdentity))
  return [...next.filter((row) => !replaced.has(schemaIdentity(row))), ...rows].sort(
    (left, right) => compareText(left.type, right.type) || compareText(left.name, right.name)
  )
}

/** SQLite's default BINARY collation, which orders the manifest. */
const compareText = (left: string, right: string): number => {
  if (left === right) return 0
  return left < right ? -1 : 1
}

const columnNames = (database: DatabaseSync, table: string): ReadonlyArray<string> =>
  database
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((column) => String(column.name))

const rebuildTable = (
  database: DatabaseSync,
  next: ReadonlyArray<SchemaManifestRow>,
  table: string,
  derived: Readonly<Record<string, string>> = {}
): void => {
  const prior = `${table}_prior`
  database.exec(`ALTER TABLE "${table}" RENAME TO "${prior}"`)
  createFrom(database, next, `table:${table}`)
  const kept = new Set(columnNames(database, prior))
  const columns = columnNames(database, table).filter((column) => kept.has(column))
  const values = columns.map((column) => derived[column] ?? column)
  database.exec(`INSERT INTO "${table}" (rowid, ${columns.join(", ")})
    SELECT rowid, ${values.join(", ")} FROM "${prior}"`)
  database.exec(`DROP TABLE "${prior}"`)
  for (const row of next) {
    if (row.tbl_name === table && row.type !== "table")
      createFrom(database, next, schemaIdentity(row))
  }
}

const createFrom = (
  database: DatabaseSync,
  next: ReadonlyArray<SchemaManifestRow>,
  identity: string
): void => {
  const sql = next.find((row) => schemaIdentity(row) === identity)?.sql
  if (sql === undefined || sql === null) {
    throw new Error(`The converted schema has no creation SQL for ${identity}`)
  }
  database.exec(sql)
}
