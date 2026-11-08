import { Schema } from "effect"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { RunAuthoritySchema } from "../src/execution/authority.js"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { runAuthority } from "../src/persistence/migrations/0017_run_authority.js"
import { spaceValue } from "../src/persistence/space-words-released.js"

const AT = "2026-10-01T10:00:00.000Z"

const open = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false })
  for (const statement of baselineStatements) database.exec(statement)
  return database
}

const job = (
  database: DatabaseSync,
  id: string,
  purpose: string,
  extra: { readonly handler?: string; readonly desk?: string; readonly task?: string } = {}
): void => {
  database
    .prepare(
      `INSERT INTO scheduled_tasks (task_id, automation_ref, name, prompt, triggers, created_at,
        purpose, handler, owner_desk_id, owner_task_id, thread_id)
       VALUES (?, ?, ?, 'p', '[]', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      `ref-${id}`,
      id,
      AT,
      purpose,
      extra.handler ?? null,
      extra.desk ?? null,
      extra.task ?? null,
      purpose === "user_automation" ? `chat-${id}` : null
    )
}

const session = (
  database: DatabaseSync,
  id: string,
  extra: {
    readonly automation?: string
    readonly agent?: { readonly mode: string; readonly parentRun: string }
  } = {}
): void => {
  database
    .prepare(
      `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type,
        origin_automation_id, parent_session_id, parent_run_id, parent_tool_call_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      `ref~${id}`,
      AT,
      AT,
      extra.agent === undefined ? "chat" : "agent",
      extra.automation ?? null,
      extra.agent === undefined ? null : "parent-chat",
      extra.agent?.parentRun ?? null,
      extra.agent === undefined ? null : "call-1",
      extra.agent === undefined ? null : JSON.stringify({ agent: { mode: extra.agent.mode } })
    )
}

const run = (
  database: DatabaseSync,
  id: string,
  sessionId: string,
  metadata: Record<string, unknown>
): void => {
  database
    .prepare(
      `INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, ended_at,
        metadata_json, assistant_message_id)
       VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)`
    )
    .run(id, sessionId, AT, AT, AT, JSON.stringify(metadata), `a-${id}`)
}

const policy = (deskId: string | null = null, observe = false) => ({
  budget_id: "b",
  budget_generation: 0,
  execution: { mode: "worker", observe },
  capabilities: ["all"],
  auto_approve: false,
  google_accounts: null,
  desk:
    deskId === null
      ? null
      : {
          desk_id: deskId,
          generation: 1,
          execution: "act",
          inference: { enabled: false },
          directories: []
        }
})

const stored = (database: DatabaseSync) =>
  Object.fromEntries(
    database
      .prepare("SELECT run_id, authority_json FROM chat_runs ORDER BY run_id")
      .all()
      .map((row) => [
        String(row["run_id"]),
        // Migration 0141 later renames desk to space in the stored record.
        Schema.decodeUnknownSync(RunAuthoritySchema)(
          JSON.parse(String(spaceValue(String(row["authority_json"]))))
        )
      ])
  )

describe("migration 0017 run_authority", () => {
  it("backfills each run's authority from its admitted records, parents before agents", () => {
    const database = open()
    job(database, "auto-1", "user_automation")
    job(database, "tasks-a", "task_execution", { desk: "desk-a", task: "task-1" })
    job(database, "capture", "system", { handler: "memory_capture" })
    session(database, "chat-1")
    session(database, "chat-auto-1")
    session(database, "task-chat", { automation: "tasks-a" })
    session(database, "capture-chat", { automation: "capture" })
    session(database, "agent-chat", { agent: { mode: "work", parentRun: "r3-task" } })
    session(database, "grandchild", { agent: { mode: "research", parentRun: "r5-agent" } })
    session(database, "orphan-chat", { agent: { mode: "code", parentRun: "gone" } })
    run(database, "r1-person", "chat-1", {
      run_context: { origin: { kind: "chat", session_id: "chat-1", turn_id: "t1" }, task: null },
      run_policy: { ...policy(), execution: { mode: "inline", observe: false } }
    })
    run(database, "r2-auto", "chat-auto-1", {
      run_context: {
        origin: { kind: "automation", automation_id: "auto-1", occurrence_id: "o1" },
        task: null
      },
      run_policy: { ...policy(), authority_session_id: "chat-auto-1" }
    })
    run(database, "r3-task", "task-chat", {
      run_context: {
        origin: { kind: "task", item_id: "task-1", occurrence_id: "o1" },
        task: { item_id: "task-1", generation: 1 }
      },
      run_policy: policy("desk-a")
    })
    run(database, "r4-capture", "capture-chat", {
      run_context: {
        origin: { kind: "automation", automation_id: "capture", occurrence_id: "o1" },
        task: null
      },
      run_policy: policy()
    })
    run(database, "r0-grandchild", "grandchild", {
      run_context: { origin: { kind: "chat", session_id: "agent-chat", turn_id: "t" }, task: null },
      run_policy: policy("desk-a")
    })
    run(database, "r5-agent", "agent-chat", {
      run_context: { origin: { kind: "chat", session_id: "task-chat", turn_id: "t" }, task: null },
      run_policy: policy("desk-a")
    })
    run(database, "r6-orphan", "orphan-chat", {
      run_context: { origin: { kind: "chat", session_id: "x", turn_id: "t" }, task: null },
      run_policy: policy()
    })
    run(database, "r7-legacy", "chat-1", {})
    run(database, "r8-unrecorded", "chat-1", {
      run_context: { origin: { kind: "unrecorded" }, task: null },
      run_policy: policy()
    })

    runAuthority.up(database)

    const authorities = stored(database)
    const summary = Object.fromEntries(
      Object.entries(authorities).map(([runId, authority]) => [
        runId,
        {
          actor:
            authority.actor.kind === "agent"
              ? `agent:${authority.actor.mode}<${authority.actor.root}`
              : authority.actor.kind,
          memory: authority.memory._tag,
          follows: authority.approval.follows.kind,
          depth: authority.delegation.depth,
          unattended: authority.unattended
        }
      ])
    )
    expect(summary).toEqual({
      "r0-grandchild": {
        actor: "agent:research<task_worker",
        memory: "Space",
        follows: "space_thread",
        depth: 2,
        unattended: true
      },
      "r1-person": {
        actor: "person",
        memory: "Global",
        follows: "chat",
        depth: 0,
        unattended: false
      },
      "r2-auto": {
        actor: "automation",
        memory: "Global",
        follows: "chat",
        depth: 0,
        unattended: true
      },
      "r3-task": {
        actor: "task_worker",
        memory: "Space",
        follows: "space_thread",
        depth: 0,
        unattended: true
      },
      "r4-capture": {
        actor: "automation",
        memory: "Capture",
        follows: "automation",
        depth: 0,
        unattended: true
      },
      "r5-agent": {
        actor: "agent:work<task_worker",
        memory: "Space",
        follows: "space_thread",
        depth: 1,
        unattended: true
      },
      "r6-orphan": {
        actor: "agent:code<unrecorded",
        memory: "None",
        follows: "chat",
        depth: 1,
        unattended: true
      },
      "r7-legacy": {
        actor: "unrecorded",
        memory: "None",
        follows: "chat",
        depth: 0,
        unattended: true
      },
      "r8-unrecorded": {
        actor: "unrecorded",
        memory: "None",
        follows: "chat",
        depth: 0,
        unattended: true
      }
    })
    expect(authorities["r0-grandchild"]?.delegation.chain).toEqual(["r3-task", "r5-agent"])
    expect(authorities["r2-auto"]?.approval.follows).toEqual({
      kind: "chat",
      session_id: "chat-auto-1"
    })
    database.close()
  })

  it("keeps an admitted authority immutable", () => {
    const database = open()
    session(database, "chat-1")
    run(database, "r1", "chat-1", {})
    runAuthority.up(database)
    expect(() =>
      database.prepare("UPDATE chat_runs SET authority_json = '{}' WHERE run_id = 'r1'").run()
    ).toThrow(/immutable/)
    database.close()
  })
})
