import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const goalsToTasks: Migration = {
  version: 44,
  name: "goals_to_tasks",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    const now = new Date().toISOString()
    for (const goal of readGoals(database)) convertGoal(database, goal, now)
    database.exec("DROP TRIGGER session_focus_delete_budget")
    database.exec("DROP TRIGGER chat_runs_delete_budget")
    database.exec(chatRunsDeleteBudget)
    database.exec("DROP INDEX idx_execution_budgets_focus")
    database.exec("DROP TABLE session_focus")
    renameGoalToolSettings(database)
  }
}

interface GoalRow {
  readonly session_id: string
  readonly focus_id: string
  readonly objective: string
  readonly status: string
  readonly evidence_json: string
  readonly blocked_reason: string | null
  readonly token_budget: number | null
  readonly tokens_used: number
  readonly created_at: string
  readonly updated_at: string
  readonly blocked_question_id: string | null
  readonly desk_id: string | null
}

interface Evidence {
  readonly kind?: string
  readonly text: string
  readonly created_at?: string
}

const readGoals = (database: DatabaseSync): ReadonlyArray<GoalRow> =>
  database
    .prepare(
      `SELECT focus.session_id, focus.focus_id, focus.objective, focus.status, focus.evidence_json,
        focus.blocked_reason, focus.token_budget, focus.tokens_used, focus.created_at,
        focus.updated_at, focus.blocked_question_id, chat.desk_id
      FROM session_focus AS focus JOIN sessions AS chat ON chat.session_id = focus.session_id
      ORDER BY focus.created_at, focus.session_id`
    )
    .all() as unknown as ReadonlyArray<GoalRow>

const TEXT_LIMIT = 80
const BODY_LIMIT = 8_000
const RESULT_LIMIT = 500
const BUDGET_SPENT = "The token budget is used up. Raise it to let Arden go on."

const clip = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`

const readEvidence = (json: string): ReadonlyArray<Evidence> => {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      "text" in item &&
      typeof item.text === "string" &&
      item.text.trim().length > 0
        ? [item as Evidence]
        : []
    )
  } catch {
    return []
  }
}

const convertGoal = (database: DatabaseSync, goal: GoalRow, now: string): void => {
  const objective = goal.objective.trim()
  const firstLine = objective.split(/\r?\n/)[0]?.trim() || "Keep working on this"
  const text = clip(firstLine, TEXT_LIMIT)
  const body = objective === text ? null : clip(objective, BODY_LIMIT)
  const scope =
    goal.desk_id === null
      ? { where: "desk_id IS NULL AND home_session_id = ?", value: goal.session_id }
      : { where: "desk_id = ?", value: goal.desk_id }
  const key = freeKey(database, scope, text)
  const itemId =
    goal.desk_id === null ? `work:chat:${goal.session_id}:${key}` : `work:${goal.desk_id}:${key}`

  const evidence = readEvidence(goal.evidence_json)
  const question =
    goal.status === "blocked" && goal.blocked_question_id !== null
      ? (database
          .prepare(
            `SELECT question_id, json_extract(content, '$.prompt') AS prompt FROM run_questions
            WHERE question_id = ? AND resolution IS NULL AND closed_at IS NULL`
          )
          .get(goal.blocked_question_id) as
          | { question_id: string; prompt: string | null }
          | undefined)
      : undefined
  const blockedLine = (() => {
    if (goal.status === "budget_limited") return BUDGET_SPENT
    if (goal.status !== "blocked") return null
    if (question?.prompt) return clip(`Answer in this chat: ${question.prompt}`, RESULT_LIMIT)
    return clip(goal.blocked_reason?.trim() || "Arden could not go on.", RESULT_LIMIT)
  })()
  const status = (() => {
    switch (goal.status) {
      case "paused":
        return "deferred"
      case "complete":
        return "done"
      default:
        return "open"
    }
  })()
  const taken =
    status !== "done" &&
    database
      .prepare(
        `SELECT 1 FROM desk_tasks WHERE home_session_id = ? AND runs_in = 'chat'
          AND status IN ('open', 'deferred') AND archived_at IS NULL`
      )
      .get(goal.session_id) !== undefined
  const seq = (
    database
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM desk_tasks WHERE ${scope.where}`)
      .get(scope.value) as { seq: number }
  ).seq

  database
    .prepare(
      `INSERT INTO desk_tasks (item_id, desk_id, home_session_id, stable_key, text, body, status,
        owner, runs_in, token_budget, blocked, waiting_on, created_at, updated_at, completed_at,
        created_by, seq, block_count, last_block_reason, capture)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'worker', ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, ?)`
    )
    .run(
      itemId,
      goal.desk_id,
      goal.session_id,
      key,
      text,
      body,
      status,
      taken ? "background" : "chat",
      goal.token_budget !== null && goal.token_budget > 0 ? goal.token_budget : null,
      blockedLine === null ? 0 : 1,
      blockedLine === null ? null : "you",
      goal.created_at,
      goal.updated_at,
      status === "done" ? goal.updated_at : null,
      seq,
      blockedLine === null ? 0 : 1,
      blockedLine === null ? null : "you",
      JSON.stringify({ basis: "explicit", reason: "Started as a Goal in this chat." })
    )

  const event = database.prepare(
    `INSERT INTO desk_task_events (desk_id, item_id, event_type, summary, content_kind,
      result_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  event.run(goal.desk_id, itemId, "created", "Started as a Goal.", "summary", null, goal.created_at)
  for (const item of evidence) {
    const at = item.created_at ?? goal.updated_at
    if (item.kind === "completion_report" && status === "done") {
      const result = clip(item.text.split("\n")[0]?.trim() || "Done.", RESULT_LIMIT)
      event.run(goal.desk_id, itemId, "done", item.text, "result", result, at)
    } else {
      event.run(goal.desk_id, itemId, "progress", item.text, "summary", null, at)
    }
  }
  if (blockedLine !== null)
    event.run(goal.desk_id, itemId, "blocked", blockedLine, "summary", null, goal.updated_at)
  if (question !== undefined)
    database
      .prepare("UPDATE run_questions SET closed_at = ? WHERE question_id = ?")
      .run(now, question.question_id)

  const moved = database
    .prepare(
      `UPDATE execution_budgets SET task_item_id = ?, token_limit = ?
      WHERE focus_id = ? AND focus_session_id = ?`
    )
    .run(
      itemId,
      goal.token_budget !== null && goal.token_budget > 0 ? goal.token_budget : null,
      goal.focus_id,
      goal.session_id
    )
  if (moved.changes === 0)
    database
      .prepare(
        `INSERT INTO execution_budgets (budget_id, task_item_id, token_limit, tokens_used)
        VALUES (?, ?, ?, ?)`
      )
      .run(
        `task:${itemId}`,
        itemId,
        goal.token_budget !== null && goal.token_budget > 0 ? goal.token_budget : null,
        Math.max(goal.tokens_used, 0)
      )
}

const freeKey = (
  database: DatabaseSync,
  scope: { readonly where: string; readonly value: string },
  text: string
): string => {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "task"
  const taken = new Set(
    database
      .prepare(
        `SELECT stable_key FROM desk_tasks
          WHERE (stable_key = ? OR stable_key LIKE ?) AND ${scope.where}`
      )
      .all(base, `${base}-%`, scope.value)
      .map((row) => String(row["stable_key"]))
  )
  if (!taken.has(base)) return base
  for (let index = 2; ; index += 1) {
    const key = `${base}-${index}`
    if (!taken.has(key)) return key
  }
}

const GOAL_TOOLS: Readonly<Record<string, string>> = {
  goal_get: "task_get",
  goal_create: "task_start",
  goal_update: "task_update",
  goal_block: "task_wait",
  goal_complete: "task_finish"
}

const renameGoalToolSettings = (database: DatabaseSync): void => {
  const row = database
    .prepare("SELECT overrides_json FROM tool_settings WHERE singleton_id = 1")
    .get()
  const stored = row?.["overrides_json"]
  if (typeof stored !== "string") return
  const overrides: unknown = JSON.parse(stored)
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return
  const next: Record<string, unknown> = { ...overrides }
  for (const [old, name] of Object.entries(GOAL_TOOLS)) {
    if (!(old in next)) continue
    const setting = next[old]
    delete next[old]
    if (!(name in next)) next[name] = setting
  }
  database
    .prepare("UPDATE tool_settings SET overrides_json = ? WHERE singleton_id = 1")
    .run(JSON.stringify(next))
}

const chatRunsDeleteBudget = `CREATE TRIGGER chat_runs_delete_budget AFTER DELETE ON chat_runs
      BEGIN
        DELETE FROM execution_budgets
        WHERE budget_id = json_extract(OLD.metadata_json, '$.run_policy.budget_id')
          AND task_item_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM chat_runs
            WHERE json_extract(metadata_json, '$.run_policy.budget_id') = execution_budgets.budget_id);
      END`
