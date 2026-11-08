import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { goalsToTasks } from "../src/persistence/migrations/0044_goals_to_tasks.js"
import { migrations } from "../src/persistence/migrations/index.js"

const AT = "2026-10-01T00:00:00.000Z"
const LATER = "2026-10-02T00:00:00.000Z"

const migrated = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false })
  for (const statement of baselineStatements) database.exec(statement)
  for (const migration of migrations.filter((entry) => entry.version < goalsToTasks.version))
    migration.up(database)
  database.exec("PRAGMA foreign_keys = ON")
  return database
}

it("migration 0044 turns each chat's Goal into the Task it works on in place", () => {
  const database = migrated()
  database.exec(`INSERT INTO desks (desk_id, name, name_key, created_at, updated_at)
    VALUES ('desk', 'Thesis', 'thesis', '${AT}', '${AT}')`)
  const chat = database.prepare(`INSERT INTO sessions (session_id, public_ref, name, started_at,
      last_activity, desk_id) VALUES (?, ?, ?, '${AT}', '${AT}', ?)`)
  for (const [id, desk] of [
    ["active", null],
    ["paused", "desk"],
    ["done", null],
    ["asking", null],
    ["spent", null]
  ] as const)
    chat.run(id, `${id}-ref`, id, desk)
  database.exec(`INSERT INTO chat_runs (run_id, session_id, status, stop_reason, started_at,
      updated_at, ended_at, metadata_json, assistant_message_id)
    VALUES ('asking-run', 'asking', 'completed', 'end_turn', '${AT}', '${AT}', '${AT}', '{}', 'r')`)
  database.exec(`INSERT INTO run_questions (question_id, run_id, tool_call_id, content, created_at)
    VALUES ('which', 'asking-run', 'call', '{"prompt":"Which chapter first?"}', '${AT}')`)
  const goal = database.prepare(`INSERT INTO session_focus (session_id, focus_id, objective, status,
      evidence_json, blocked_reason, token_budget, tokens_used, created_at, updated_at,
      blocked_question_id) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '${AT}', '${LATER}', ?)`)
  goal.run(
    "active",
    "g1",
    "Draft chapter two\nKeep the citations.",
    "active",
    "[]",
    null,
    1000,
    null
  )
  goal.run("paused", "g2", "Edit chapter one", "paused", "[]", null, null, null)
  goal.run(
    "done",
    "g3",
    "Fix the bibliography",
    "complete",
    JSON.stringify([
      { text: "Checked every entry.", created_at: AT },
      {
        kind: "completion_report",
        text: "Bibliography fixed.\n\nEvidence:\n- Ran the check",
        created_at: LATER
      }
    ]),
    null,
    null,
    null
  )
  goal.run("asking", "g4", "Plan the defence", "blocked", "[]", "Needs a choice", null, "which")
  goal.run("spent", "g5", "Translate the abstract", "budget_limited", "[]", null, 50, null)
  database.exec(`INSERT INTO execution_budgets (budget_id, tokens_used, token_limit, focus_id,
      focus_session_id) VALUES ('focus:g1', 300, 1000, 'g1', 'active')`)
  database
    .prepare("UPDATE tool_settings SET overrides_json = ? WHERE singleton_id = 1")
    .run(JSON.stringify({ goal_complete: "ask", task_get: "approve" }))

  goalsToTasks.up(database)

  expect(
    database
      .prepare(
        `SELECT home_session_id, desk_id, stable_key, text, body, status, runs_in, token_budget,
          blocked, waiting_on, completed_at FROM desk_tasks ORDER BY home_session_id`
      )
      .all()
  ).toEqual([
    {
      home_session_id: "active",
      desk_id: null,
      stable_key: "draft-chapter-two",
      text: "Draft chapter two",
      body: "Draft chapter two\nKeep the citations.",
      status: "open",
      runs_in: "chat",
      token_budget: 1000,
      blocked: 0,
      waiting_on: null,
      completed_at: null
    },
    {
      home_session_id: "asking",
      desk_id: null,
      stable_key: "plan-the-defence",
      text: "Plan the defence",
      body: null,
      status: "open",
      runs_in: "chat",
      token_budget: null,
      blocked: 1,
      waiting_on: "you",
      completed_at: null
    },
    {
      home_session_id: "done",
      desk_id: null,
      stable_key: "fix-the-bibliography",
      text: "Fix the bibliography",
      body: null,
      status: "done",
      runs_in: "chat",
      token_budget: null,
      blocked: 0,
      waiting_on: null,
      completed_at: LATER
    },
    {
      home_session_id: "paused",
      desk_id: "desk",
      stable_key: "edit-chapter-one",
      text: "Edit chapter one",
      body: null,
      status: "deferred",
      runs_in: "chat",
      token_budget: null,
      blocked: 0,
      waiting_on: null,
      completed_at: null
    },
    {
      home_session_id: "spent",
      desk_id: null,
      stable_key: "translate-the-abstract",
      text: "Translate the abstract",
      body: null,
      status: "open",
      runs_in: "chat",
      token_budget: 50,
      blocked: 1,
      waiting_on: "you",
      completed_at: null
    }
  ])
  expect(
    database
      .prepare(
        `SELECT event.event_type, event.summary, event.content_kind, event.result_summary
        FROM desk_task_events AS event JOIN desk_tasks AS task ON task.item_id = event.item_id
        WHERE task.home_session_id IN ('done', 'asking') AND event.event_type <> 'created'
        ORDER BY task.home_session_id, event.event_id`
      )
      .all()
  ).toEqual([
    {
      event_type: "blocked",
      summary: "Answer in this chat: Which chapter first?",
      content_kind: "summary",
      result_summary: null
    },
    {
      event_type: "progress",
      summary: "Checked every entry.",
      content_kind: "summary",
      result_summary: null
    },
    {
      event_type: "done",
      summary: "Bibliography fixed.\n\nEvidence:\n- Ran the check",
      content_kind: "result",
      result_summary: "Bibliography fixed."
    }
  ])
  expect(
    database.prepare("SELECT closed_at IS NOT NULL AS closed FROM run_questions").get()
  ).toEqual({ closed: 1 })
  expect(
    database
      .prepare(
        `SELECT budget.budget_id, budget.tokens_used, task.home_session_id
        FROM execution_budgets AS budget JOIN desk_tasks AS task ON task.item_id = budget.task_item_id
        ORDER BY task.home_session_id`
      )
      .all()
  ).toEqual([
    { budget_id: "focus:g1", tokens_used: 300, home_session_id: "active" },
    { budget_id: expect.stringMatching(/^task:/), tokens_used: 0, home_session_id: "asking" },
    { budget_id: expect.stringMatching(/^task:/), tokens_used: 0, home_session_id: "done" },
    { budget_id: expect.stringMatching(/^task:/), tokens_used: 0, home_session_id: "paused" },
    { budget_id: expect.stringMatching(/^task:/), tokens_used: 0, home_session_id: "spent" }
  ])
  expect(
    database.prepare("SELECT name FROM sqlite_master WHERE name = 'session_focus'").all()
  ).toEqual([])
  expect(
    JSON.parse(
      String(database.prepare("SELECT overrides_json FROM tool_settings").get()?.["overrides_json"])
    )
  ).toEqual({ task_finish: "ask", task_get: "approve" })
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
  database.close()
})
