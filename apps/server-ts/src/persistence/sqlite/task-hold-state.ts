import type { SqlClient, Statement } from "effect/unstable/sql"

export const taskHasHold = (
  sql: SqlClient.SqlClient,
  task: Statement.Fragment
): Statement.Fragment => sql`EXISTS (
  SELECT 1 FROM space_task_holds AS hold
  WHERE hold.item_id = ${task}.item_id AND hold.task_generation = ${task}.generation
    AND ${task}.status = 'open' AND ${task}.blocked = 1
)`
