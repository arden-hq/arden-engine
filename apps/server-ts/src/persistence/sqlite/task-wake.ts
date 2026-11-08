import type { SqlClient, Statement } from "effect/unstable/sql"
import type { TaskRow } from "./space-job-rows.js"
import { taskHasHold } from "./task-hold-state.js"
import { taskOpenSql } from "./task-status-sql.js"

export const taskIsLive = (task: TaskRow): boolean => task.status === "open" && task.held === 0

export const taskStands = (task: TaskRow): boolean =>
  taskIsLive(task) && task.owner === "worker" && task.space_archived_at === null

export const taskMayWake = (task: TaskRow): boolean => taskStands(task) && task.blocked === 0

export const taskStandsSql = (sql: SqlClient.SqlClient, alias: string): Statement.Fragment => {
  const task = sql.literal(alias)
  return sql`(${taskOpenSql(alias)}
    AND ${task}.owner = 'worker' AND NOT ${taskHasHold(sql, task)}
    AND (${task}.space_id IS NULL OR NOT EXISTS (SELECT 1 FROM spaces AS owning
      WHERE owning.space_id = ${task}.space_id AND owning.archived_at IS NOT NULL)))`
}

export const taskMayWakeSql = (sql: SqlClient.SqlClient, alias: string): Statement.Fragment =>
  sql`(${taskStandsSql(sql, alias)} AND ${sql.literal(alias)}.blocked = 0)`
